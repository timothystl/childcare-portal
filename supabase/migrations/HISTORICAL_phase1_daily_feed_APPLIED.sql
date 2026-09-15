-- APPLIED TO PRODUCTION 2026-08-12. Four migrations, recorded together:
--   phase1_daily_feed_schema
--   phase1_daily_feed_policies
--   phase1_staff_logging_rpcs  (+ phase1_log_child_event_fix_attendance)
--   phase1_fix_photo_consent_nested_rls
--
-- ============================================================
-- PHASE 1 — the daily feed (data layer)
-- ============================================================
-- Design: docs/PARENT_PORTAL_PLAN.md §5.
--
-- ⚠️ TYPE TRAP, already paid for once (add_staff_time_off_requests failed with
-- 42804 on exactly this): students.id, staff.id, families.id, closures.id and
-- attendance_records.id are uuid. registrations.id is BIGINT. Never coerce a
-- staff or student id with Number()/parseInt().
--
-- ACCESS MODEL, three distinct callers:
--   parents — SELECT only, own children only, via parent_family_ids()
--   admin   — full, via is_admin()
--   staff   — WRITE via PIN-gated SECURITY DEFINER RPCs, never table grants.
--             Staff work from personal phones on the public anon key; a PIN is
--             the credential they have. Same shape as lookup_staff_by_pin and
--             submit_time_off_request. Granting anon table writes instead is
--             what left staff_clock_events open for months.
-- anon gets NO grant on any table here.

-- ── Tables ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.child_day_events (
    id                    bigserial PRIMARY KEY,
    student_id            uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    registration_id       bigint REFERENCES public.registrations(id) ON DELETE SET NULL,
    care_date             date NOT NULL,
    event_type            text NOT NULL CHECK (event_type IN (
                              'check_in','check_out','nap_start','nap_end',
                              'diaper','bottle','meal','note','supplies')),
    -- Staff-editable: a nap that ended at 2pm may be logged at 2:40. The
    -- timeline orders by this, not by created_at.
    occurred_at           timestamptz NOT NULL DEFAULT now(),
    detail                jsonb NOT NULL DEFAULT '{}'::jsonb,
    recorded_by_staff_id  uuid REFERENCES public.staff(id) ON DELETE SET NULL,
    created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS child_day_events_student_date_idx
    ON public.child_day_events (student_id, care_date DESC, occurred_at);
CREATE INDEX IF NOT EXISTS child_day_events_date_idx ON public.child_day_events (care_date DESC);

-- Retention differs by kind, and is explicit rather than implied by a cleanup
-- job's hardcoded interval: daily photos are ephemeral (parents are told so),
-- incident photos are evidence — guidelines 3 years, statute of limitations 5,
-- major injury until the child is 23. Incident photos get a NULL expiry and are
-- removed by hand, never by a sweeper.
CREATE TABLE IF NOT EXISTS public.child_photos (
    id                  bigserial PRIMARY KEY,
    kind                text NOT NULL DEFAULT 'daily' CHECK (kind IN ('daily','incident')),
    room_id             text,
    care_date           date NOT NULL,
    storage_path        text NOT NULL UNIQUE,
    caption             text,
    posted_by_staff_id  uuid REFERENCES public.staff(id) ON DELETE SET NULL,
    expires_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS child_photos_date_idx ON public.child_photos (care_date DESC);
CREATE INDEX IF NOT EXISTS child_photos_expiry_idx ON public.child_photos (expires_at)
    WHERE expires_at IS NOT NULL;

-- A join table, not a jsonb array, because consent is a QUERY not a display
-- detail: a photo is visible only if EVERY child in it has photo_release.
CREATE TABLE IF NOT EXISTS public.child_photo_students (
    photo_id    bigint NOT NULL REFERENCES public.child_photos(id) ON DELETE CASCADE,
    student_id  uuid   NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    PRIMARY KEY (photo_id, student_id)
);
CREATE INDEX IF NOT EXISTS child_photo_students_student_idx
    ON public.child_photo_students (student_id);

-- Purely informational. May reference a closure for context, but writes no
-- billing and changes no charge — closures stay the source of truth for
-- closed days.
CREATE TABLE IF NOT EXISTS public.announcements (
    id            bigserial PRIMARY KEY,
    title         text NOT NULL,
    body          text NOT NULL,
    closure_id    uuid REFERENCES public.closures(id) ON DELETE SET NULL,
    published_at  timestamptz,
    expires_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS announcements_published_idx
    ON public.announcements (published_at DESC) WHERE published_at IS NOT NULL;

ALTER TABLE public.child_day_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.child_photos         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.child_photo_students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcements        ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.child_day_events, public.child_photos,
              public.child_photo_students, public.announcements FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON public.child_day_events, public.child_photos,
       public.child_photo_students, public.announcements TO authenticated;

-- ── Policies ────────────────────────────────────────────────
-- ⚠️ Every policy names its role explicitly. NOT `TO public` — that is what
-- leaked staff wages and church payroll to a parent on this same day, because
-- `public` includes `authenticated`. Add a policy here, then re-run
-- portal.html?check=1.

CREATE OR REPLACE FUNCTION public.parent_owns_student(p_student_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM students s
        WHERE s.id = p_student_id AND s.family_id IN (SELECT parent_family_ids())
    );
$$;
REVOKE EXECUTE ON FUNCTION public.parent_owns_student(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.parent_owns_student(uuid) TO authenticated;

CREATE POLICY "admin any role" ON public.child_day_events
    FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "parent read own" ON public.child_day_events
    FOR SELECT TO authenticated USING (parent_owns_student(student_id));

CREATE POLICY "admin any role" ON public.child_photo_students
    FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
-- A parent may only learn that their OWN child is in a photo. Without this the
-- join table discloses which other children were present, which is exactly what
-- photo_release protects.
CREATE POLICY "parent read own" ON public.child_photo_students
    FOR SELECT TO authenticated USING (parent_owns_student(student_id));

CREATE POLICY "admin any role" ON public.announcements
    FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "parent read published" ON public.announcements
    FOR SELECT TO authenticated USING (
        published_at IS NOT NULL AND published_at <= now()
        AND (expires_at IS NULL OR expires_at > now())
    );

-- ── Photo consent: why these are SECURITY DEFINER ───────────
-- ⚠️ THE BUG THIS FIXES SHIPPED IN THE FIRST DRAFT AND WAS CAUGHT BY TEST.
-- Consent was expressed inline in the child_photos policy:
--
--   AND NOT EXISTS (SELECT 1 FROM child_photo_students cps
--                   JOIN students st ON st.id = cps.student_id
--                   WHERE cps.photo_id = child_photos.id
--                     AND st.photo_release IS DISTINCT FROM true)
--
-- That subquery is ITSELF subject to RLS. child_photo_students limits a parent
-- to their own child's rows, so from a parent's session the subquery could not
-- see the other children in the photo — NOT EXISTS was trivially TRUE and the
-- check silently passed. A photo containing an opted-out child was visible to
-- another family: precisely the harm photo_release exists to prevent.
--
-- The check needs a view of the data the parent does not have, so it runs as
-- definer. Fails CLOSED: a photo with no depicted children is not releasable.
CREATE OR REPLACE FUNCTION public.photo_is_releasable(p_photo_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (SELECT 1 FROM child_photo_students WHERE photo_id = p_photo_id)
       AND NOT EXISTS (
           SELECT 1 FROM child_photo_students cps
           JOIN students st ON st.id = cps.student_id
           WHERE cps.photo_id = p_photo_id AND st.photo_release IS DISTINCT FROM true
       );
$$;
REVOKE EXECUTE ON FUNCTION public.photo_is_releasable(bigint) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.photo_is_releasable(bigint) TO authenticated;

CREATE OR REPLACE FUNCTION public.photo_depicts_my_child(p_photo_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM child_photo_students cps
        JOIN students st ON st.id = cps.student_id
        WHERE cps.photo_id = p_photo_id AND st.family_id IN (SELECT parent_family_ids())
    );
$$;
REVOKE EXECUTE ON FUNCTION public.photo_depicts_my_child(bigint) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.photo_depicts_my_child(bigint) TO authenticated;

CREATE POLICY "admin any role" ON public.child_photos
    FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "parent read own" ON public.child_photos
    FOR SELECT TO authenticated
    USING (photo_depicts_my_child(id) AND photo_is_releasable(id));

-- ── Staff write path ────────────────────────────────────────
-- search_path pinned to 'public','extensions' because crypt() lives in
-- extensions (SS10 hardening). Omitting it fails at runtime, not at deploy.
CREATE OR REPLACE FUNCTION public.staff_id_for_pin(p_pin integer)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public','extensions' AS $$
    SELECT s.id FROM staff s
    WHERE s.active = true AND s.staff_pin_hash IS NOT NULL
      AND crypt(p_pin::text, s.staff_pin_hash) = s.staff_pin_hash
    LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION public.staff_id_for_pin(integer) FROM PUBLIC;
-- Deliberately NOT granted to anon: internal helper. The RPCs below never
-- return a staff id to the browser.

-- Returns NULL on a bad PIN rather than raising, so a wrong PIN is
-- indistinguishable from any other failure (matches the time-off RPCs).
CREATE OR REPLACE FUNCTION public.log_child_event(
    p_pin integer, p_student_id uuid, p_event_type text,
    p_detail jsonb DEFAULT '{}'::jsonb,
    p_occurred_at timestamptz DEFAULT NULL, p_care_date date DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
DECLARE
    v_staff_id uuid; v_at timestamptz; v_date date; v_reg record; v_id bigint;
BEGIN
    v_staff_id := staff_id_for_pin(p_pin);
    IF v_staff_id IS NULL THEN RETURN NULL; END IF;

    IF p_event_type NOT IN ('check_in','check_out','nap_start','nap_end',
                            'diaper','bottle','meal','note','supplies') THEN
        RETURN NULL;
    END IF;

    v_at   := COALESCE(p_occurred_at, now());
    v_date := COALESCE(p_care_date, (v_at AT TIME ZONE 'America/Chicago')::date);

    SELECT r.id, r.room_id, r.child_name INTO v_reg
    FROM registrations r
    JOIN registration_dates rd ON rd.registration_id = r.id
    JOIN students st ON st.id = p_student_id
    WHERE rd.care_date = v_date AND rd.waitlisted IS NOT TRUE
      AND lower(r.child_name) = lower(st.child_name)
    LIMIT 1;

    INSERT INTO child_day_events (student_id, registration_id, care_date,
                                  event_type, occurred_at, detail, recorded_by_staff_id)
    VALUES (p_student_id, v_reg.id, v_date, p_event_type, v_at,
            COALESCE(p_detail, '{}'::jsonb), v_staff_id)
    RETURNING id INTO v_id;

    -- ⚠️ attendance_records keys on (registration_id, care_date), NOT
    -- student_id, and registration_id is NOT NULL. The first draft inserted
    -- student_id and would have failed on the first real check-in — inside
    -- plpgsql, so nothing caught it at deploy time.
    --
    -- A drop-in with no booked registration therefore gets a child_day_event
    -- but NO attendance row. Correct trade: refusing to record care that
    -- actually happened would be worse than an attendance report that only
    -- covers booked children, which is all it has ever covered.
    IF p_event_type = 'check_in' AND v_reg.id IS NOT NULL THEN
        INSERT INTO attendance_records (registration_id, care_date, room_id,
                                        child_name, status, recorded_by)
        VALUES (v_reg.id, v_date, v_reg.room_id, v_reg.child_name, 'present', 'kiosk')
        ON CONFLICT (registration_id, care_date)
        DO UPDATE SET status = 'present', recorded_at = now();
    END IF;

    RETURN v_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.log_child_event(integer, uuid, text, jsonb, timestamptz, date) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.log_child_event(integer, uuid, text, jsonb, timestamptz, date) TO anon, authenticated;

-- The staff roster: who is booked into a room today, with the allergy and care
-- data the quick-log sheet must show above every input. Empty on a bad PIN.
CREATE OR REPLACE FUNCTION public.list_room_children(
    p_pin integer, p_room_id text, p_care_date date DEFAULT NULL)
RETURNS TABLE (student_id uuid, child_name text, allergies jsonb,
               care_notes text, photo_release boolean, checked_in boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
DECLARE v_staff_id uuid; v_date date;
BEGIN
    v_staff_id := staff_id_for_pin(p_pin);
    IF v_staff_id IS NULL THEN RETURN; END IF;
    v_date := COALESCE(p_care_date, (now() AT TIME ZONE 'America/Chicago')::date);

    RETURN QUERY
    SELECT DISTINCT ON (st.id)
        st.id, st.child_name, st.allergies, st.care_notes, st.photo_release,
        EXISTS (SELECT 1 FROM child_day_events e
                WHERE e.student_id = st.id AND e.care_date = v_date
                  AND e.event_type = 'check_in') AS checked_in
    FROM registrations r
    JOIN registration_dates rd ON rd.registration_id = r.id
    JOIN students st ON lower(st.child_name) = lower(r.child_name)
    WHERE rd.care_date = v_date AND rd.waitlisted IS NOT TRUE AND r.room_id = p_room_id
    ORDER BY st.id, st.child_name;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.list_room_children(integer, text, date) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.list_room_children(integer, text, date) TO anon, authenticated;

-- ============================================================
-- VERIFIED AFTER APPLYING, as the roles themselves (all rolled back)
-- ============================================================
-- staff path, as anon:
--   bad PIN -> NULL; bad event_type -> NULL; good check_in -> id
--   3 events logged, all carrying recorded_by_staff_id + registration_id
--   attendance upsert idempotent: two check_ins -> 1 row, status 'present'
--   jsonb detail round-trips ({"oz": 4})
-- parent path, as the real parent session:
--   events        1 of 2 visible (only their own child)
--   announcements 1 of 2 visible (draft hidden)
--   photos        solo + all-released group visible;
--                 opted-out group HIDDEN, other family's photo HIDDEN,
--                 untagged photo HIDDEN (fails closed)
