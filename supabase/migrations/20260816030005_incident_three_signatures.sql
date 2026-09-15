-- ============================================================
-- INCIDENT REPORTS — three signatures, in order (design handoff, Surface 1 §4)
-- ============================================================
-- Teacher signs when filing -> parent signs on the teacher's phone at pickup ->
-- director signs to close it. The printable copy unlocks only after all three.
-- A half-signed report cannot leave the building.
--
-- ⚠️ ORDER IS ENFORCED IN THE DATABASE, not just in the UI. The handoff says
-- "Enforce server-side, not just in the UI" and "Enforce in the API" twice. A
-- signature is a legal artifact; a client that can post them out of order can
-- manufacture a record in which a parent appears to have acknowledged an injury
-- before the teacher had written it down.
--
-- ⚠️ SAFE TO ENFORCE RETROACTIVELY BECAUSE THE TABLE IS EMPTY. Verified against
-- production 2026-08-16: `select count(*) from incident_reports` = 0. Nobody has
-- ever filed one, so there are no two-signature legacy rows to grandfather and
-- no backfill to get wrong. If that had not been true, this migration would have
-- needed a `signature_model` column to exempt older records from the print gate.
--
-- ⚠️ WHAT THIS MIGRATION DELIBERATELY DOES **NOT** CHANGE: when the family can
-- READ the report. The handoff says the parent is notified as soon as the
-- teacher signs and does not wait on the director. phase1_incident_reports
-- APPLIED the opposite on 2026-08-12, for a stated and sound reason — an
-- incident is the one case where a staff member's first phrasing reaches a
-- parent unedited at the worst possible moment.
--   Both survive, because they are answering different questions:
--     * NOTIFICATION is early. `notify_parent_of_incident()` stamps
--       parent_notified_at when the teacher signs, and the push carries no
--       detail (same policy as the existing one) — it says come see us.
--     * PUBLICATION stays at director sign-off. The "parent read approved"
--       policy is untouched, so the readable report still appears only when the
--       record is closed.
--   The parent signs at pickup on the TEACHER's phone, which needs no portal
--   read at all, so the pickup signature works regardless.

BEGIN;

-- ── 1. New columns on the report ────────────────────────────
ALTER TABLE public.incident_reports
    -- occurred_at is when it happened (teacher-set, steppable, no back-date
    -- limit). filed_at is when the app received it. The handoff shows BOTH on
    -- the record and on the print, precisely so the gap is visible rather than
    -- collapsed into one ambiguous timestamp.
    ADD COLUMN IF NOT EXISTS filed_at    timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS witnesses   text[]      NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS first_aid   text[]      NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS body_view   text CHECK (body_view IN ('front','back')),
    ADD COLUMN IF NOT EXISTS body_part   text,
    -- Staff-to-child ratio at the time of the incident. Item 5 on the printed
    -- report; licensing asks for it, and it cannot be re-derived later without
    -- re-deriving who was clocked in months ago.
    ADD COLUMN IF NOT EXISTS ratio_note  text;

COMMENT ON COLUMN public.incident_reports.occurred_at IS
    'When the incident happened. Teacher-set, no back-date limit, never in the future.';
COMMENT ON COLUMN public.incident_reports.filed_at IS
    'When the app received the report. Never equal to occurred_at by construction.';

-- ── 2. The signatures ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.incident_signatures (
    id            bigserial PRIMARY KEY,
    incident_id   bigint NOT NULL REFERENCES public.incident_reports(id) ON DELETE RESTRICT,
    -- 1 teacher, 2 parent, 3 director. Stored as text for readability; the
    -- ordinal that the trigger enforces comes from incident_sig_ordinal().
    role          text NOT NULL CHECK (role IN ('teacher','parent','director')),
    -- The typed name is the signature. The app renders it in Dancing Script,
    -- which is presentation — the record is the name, the timestamp, and who
    -- was authenticated when it was written.
    signed_name   text NOT NULL CHECK (btrim(signed_name) <> ''),
    signed_at     timestamptz NOT NULL DEFAULT now(),
    -- Which credential authorized the signature. For a parent signature this is
    -- the teacher whose phone was unlocked — the parent has no login at pickup,
    -- so the honest record is "signed in person on Amy W.'s device".
    signed_by_staff_id  uuid REFERENCES public.staff(id) ON DELETE SET NULL,
    signed_on_device_of text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (incident_id, role)
);
-- ON DELETE RESTRICT, matching incident_reports.student_id: a signature is
-- evidence and does not get swept along behind something else's deletion.

CREATE INDEX IF NOT EXISTS incident_signatures_incident_idx
    ON public.incident_signatures (incident_id);

-- ── 3. Order enforcement ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.incident_sig_ordinal(p_role text)
RETURNS int LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
    SELECT CASE p_role WHEN 'teacher' THEN 1 WHEN 'parent' THEN 2
                       WHEN 'director' THEN 3 ELSE 0 END;
$$;

CREATE OR REPLACE FUNCTION public.incident_signature_order_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE v_need int; v_have int;
BEGIN
    v_need := incident_sig_ordinal(NEW.role) - 1;
    IF v_need > 0 THEN
        SELECT count(*) INTO v_have
        FROM incident_signatures
        WHERE incident_id = NEW.incident_id
          AND incident_sig_ordinal(role) <= v_need;
        IF v_have < v_need THEN
            RAISE EXCEPTION
                'incident % : cannot record a % signature before the % that precedes it',
                NEW.incident_id, NEW.role,
                CASE NEW.role WHEN 'parent' THEN 'teacher signature'
                              ELSE 'teacher and parent signatures' END
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS incident_signature_order ON public.incident_signatures;
CREATE TRIGGER incident_signature_order
    BEFORE INSERT ON public.incident_signatures
    FOR EACH ROW EXECUTE FUNCTION public.incident_signature_order_guard();

-- A signature is never edited or withdrawn. Correcting a report means the
-- director returns it and the teacher files again.
CREATE OR REPLACE FUNCTION public.incident_signature_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
    RAISE EXCEPTION 'incident signatures are append-only'
        USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS incident_signature_no_update ON public.incident_signatures;
CREATE TRIGGER incident_signature_no_update
    BEFORE UPDATE ON public.incident_signatures
    FOR EACH ROW EXECUTE FUNCTION public.incident_signature_immutable();

-- ── 4. Is the record complete? ──────────────────────────────
CREATE OR REPLACE FUNCTION public.incident_is_complete(p_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public' AS $$
    SELECT count(DISTINCT role) = 3
    FROM incident_signatures
    WHERE incident_id = p_id
      AND role IN ('teacher','parent','director');
$$;

-- ── 5. Filing = the teacher's signature ─────────────────────
-- Extends the applied submit_incident_report.
--
-- ⚠️ THE OLD 9-ARG VERSION IS DROPPED, NOT KEPT AS A SHIM. Two overloads would
-- be the obvious move (FS5 phase 2 did exactly that) and it is wrong here:
-- supabase-js sends NAMED parameters, and nine named arguments match both the
-- 9-arg function and the 15-arg one whose extras all default. PostgREST cannot
-- choose between them and fails the call with "Could not choose the best
-- candidate function". One function with defaults is what makes deploy order
-- not matter — the currently-deployed 9-argument caller resolves to it
-- unchanged, and the six new parameters simply take their defaults.
DROP FUNCTION IF EXISTS public.submit_incident_report(
    uuid, integer, uuid, text, text, text, text, text, timestamptz);

CREATE OR REPLACE FUNCTION public.submit_incident_report(
    p_staff_id      uuid,
    p_pin           integer,
    p_student_id    uuid,
    p_incident_type text,
    p_description   text,
    p_action_taken  text,
    p_location      text    DEFAULT NULL,
    p_body_area     text    DEFAULT NULL,
    p_occurred_at   timestamptz DEFAULT NULL,
    p_body_view     text    DEFAULT NULL,
    p_body_part     text    DEFAULT NULL,
    p_witnesses     text[]  DEFAULT NULL,
    p_first_aid     text[]  DEFAULT NULL,
    p_ratio_note    text    DEFAULT NULL,
    p_signed_name   text    DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
DECLARE v_staff_id uuid; v_name text; v_at timestamptz; v_id bigint;
BEGIN
    v_staff_id := staff_id_for_pin(p_staff_id, p_pin);
    IF v_staff_id IS NULL THEN RETURN NULL; END IF;

    IF p_incident_type NOT IN ('injury','illness','behavior','other') THEN RETURN NULL; END IF;
    IF COALESCE(btrim(p_description), '') = '' OR COALESCE(btrim(p_action_taken), '') = '' THEN
        RETURN NULL;
    END IF;
    IF p_body_view IS NOT NULL AND p_body_view NOT IN ('front','back') THEN RETURN NULL; END IF;

    SELECT name INTO v_name FROM staff WHERE id = v_staff_id;

    -- No back-date limit — the handoff is explicit that a teacher sets the exact
    -- time and may pick a different day. The only bound is the one it states:
    -- not in the future. A future incident time is a typo or a forgery, and
    -- either way it must not become the record.
    v_at := LEAST(COALESCE(p_occurred_at, now()), now());

    INSERT INTO incident_reports (
        student_id, care_date, occurred_at, filed_at, incident_type,
        location, body_area, body_view, body_part,
        description, action_taken, witnesses, first_aid, ratio_note,
        reported_by_staff_id, reported_by_name, status
    ) VALUES (
        p_student_id, (v_at AT TIME ZONE 'America/Chicago')::date, v_at, now(),
        p_incident_type,
        nullif(btrim(p_location), ''), nullif(btrim(p_body_area), ''),
        p_body_view, nullif(btrim(p_body_part), ''),
        btrim(p_description), btrim(p_action_taken),
        COALESCE(p_witnesses, '{}'), COALESCE(p_first_aid, '{}'),
        nullif(btrim(p_ratio_note), ''),
        v_staff_id, v_name,
        'submitted'          -- never 'approved'; only the director can do that
    ) RETURNING id INTO v_id;

    -- Signature 1. Filing IS signing: the handoff's banner reads "Sign it
    -- yourself first", and there is no separate teacher-sign step anywhere in
    -- the flow. Recorded from the PIN holder, never from the request body.
    INSERT INTO incident_signatures (incident_id, role, signed_name, signed_by_staff_id)
    VALUES (v_id, 'teacher', COALESCE(nullif(btrim(p_signed_name), ''), v_name, 'Staff'), v_staff_id);

    RETURN v_id;
END;
$$;

-- The grant has to be restated: DROP took the old function's grants with it,
-- and the replacement is a new object as far as the catalog is concerned.
REVOKE ALL ON FUNCTION public.submit_incident_report(
    uuid, integer, uuid, text, text, text, text, text, timestamptz,
    text, text, text[], text[], text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_incident_report(
    uuid, integer, uuid, text, text, text, text, text, timestamptz,
    text, text, text[], text[], text, text) TO anon, authenticated;

-- ── 6. Signature 2 — the parent, at pickup, on the teacher's phone ──
-- PIN-gated on the TEACHER, because that is who is authenticated on the device.
-- The parent is identified by the name they type and by the student they are
-- signing for; the record says whose phone it happened on.
CREATE OR REPLACE FUNCTION public.sign_incident_parent(
    p_staff_id uuid, p_pin integer, p_incident_id bigint, p_signed_name text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
DECLARE v_staff_id uuid; v_staff_name text;
BEGIN
    v_staff_id := staff_id_for_pin(p_staff_id, p_pin);
    IF v_staff_id IS NULL THEN RETURN false; END IF;
    IF COALESCE(btrim(p_signed_name), '') = '' THEN RETURN false; END IF;
    IF NOT EXISTS (SELECT 1 FROM incident_reports WHERE id = p_incident_id) THEN RETURN false; END IF;

    SELECT name INTO v_staff_name FROM staff WHERE id = v_staff_id;

    -- The order trigger is the real guard; this only turns a would-be exception
    -- into a clean false for a UI that raced itself.
    IF NOT EXISTS (SELECT 1 FROM incident_signatures
                   WHERE incident_id = p_incident_id AND role = 'teacher') THEN
        RETURN false;
    END IF;

    INSERT INTO incident_signatures
        (incident_id, role, signed_name, signed_by_staff_id, signed_on_device_of)
    VALUES (p_incident_id, 'parent', btrim(p_signed_name), v_staff_id, v_staff_name)
    ON CONFLICT (incident_id, role) DO NOTHING;

    -- Idempotent, not FOUND. A double-tap at the pickup counter conflicts and
    -- leaves FOUND false, which would tell a parent who HAS signed that their
    -- signature failed — and the natural next move is to sign again.
    RETURN EXISTS (SELECT 1 FROM incident_signatures
                   WHERE incident_id = p_incident_id AND role = 'parent');
END;
$$;

-- ── 7. Signature 3 — the director, which closes and publishes ──
CREATE OR REPLACE FUNCTION public.sign_incident_director(
    p_id bigint, p_signed_name text DEFAULT NULL, p_notes text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_who text;
BEGIN
    IF NOT is_admin() THEN RETURN false; END IF;

    v_who := COALESCE(nullif(btrim(p_signed_name), ''), auth.jwt() ->> 'email', 'Director');

    IF NOT EXISTS (SELECT 1 FROM incident_signatures
                   WHERE incident_id = p_id AND role = 'parent') THEN
        -- She is signature 3. If the parent has not signed at pickup yet, the
        -- record is not hers to close — the drawer shows this as "waiting on
        -- the parent" rather than offering the button.
        RETURN false;
    END IF;

    INSERT INTO incident_signatures (incident_id, role, signed_name)
    VALUES (p_id, 'director', v_who)
    ON CONFLICT (incident_id, role) DO NOTHING;

    UPDATE incident_reports
    SET status         = 'approved',
        reviewed_by    = COALESCE(auth.jwt() ->> 'email', 'unknown'),
        reviewed_at    = now(),
        director_notes = COALESCE(nullif(btrim(p_notes), ''), director_notes)
    WHERE id = p_id;

    RETURN true;
END;
$$;

-- ── 8. Early notification, without early publication ────────
-- Stamps parent_notified_at at teacher-sign time so the handoff's "the parent
-- does not wait on the director" holds for the NOTIFICATION, while the
-- "parent read approved" policy keeps the readable report at sign-off.
CREATE OR REPLACE FUNCTION public.notify_parent_of_incident(
    p_staff_id uuid, p_pin integer, p_incident_id bigint
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
DECLARE v_staff_id uuid;
BEGIN
    v_staff_id := staff_id_for_pin(p_staff_id, p_pin);
    IF v_staff_id IS NULL THEN RETURN false; END IF;

    UPDATE incident_reports
    SET parent_notified_at = COALESCE(parent_notified_at, now())
    WHERE id = p_incident_id;

    RETURN FOUND;
END;
$$;

-- ── 9. The print gate ───────────────────────────────────────
-- "The document must be generated server-side from the record, not from a
-- client screenshot, and must refuse to render until all three signatures
-- exist." This is that refusal. The client cannot assemble a printable copy
-- from its own state because the copy comes from here.
CREATE OR REPLACE FUNCTION public.incident_print_record(p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_row incident_reports; v_out jsonb;
BEGIN
    SELECT * INTO v_row FROM incident_reports WHERE id = p_id;
    IF NOT FOUND THEN RETURN NULL; END IF;

    -- Who may ask: the office, or this child's own family.
    IF NOT (is_admin() OR parent_owns_student(v_row.student_id)) THEN
        RETURN NULL;
    END IF;

    -- ⚠️ The gate. Not a UI disable — there is no path to the document without
    -- all three, for anyone, including the director.
    IF NOT incident_is_complete(p_id) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'incomplete',
            'have', (SELECT COALESCE(jsonb_agg(role ORDER BY incident_sig_ordinal(role)), '[]'::jsonb)
                     FROM incident_signatures WHERE incident_id = p_id));
    END IF;

    SELECT jsonb_build_object(
        'ok', true,
        'report', to_jsonb(v_row),
        'child', (SELECT jsonb_build_object('child_name', s.child_name, 'child_dob', s.child_dob,
                                            'room_id', COALESCE(s.room_override, ''))
                  FROM students s WHERE s.id = v_row.student_id),
        'signatures', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                            'role', g.role, 'signed_name', g.signed_name,
                            'signed_at', g.signed_at, 'on_device_of', g.signed_on_device_of)
                          ORDER BY incident_sig_ordinal(g.role)), '[]'::jsonb)
                       FROM incident_signatures g WHERE g.incident_id = p_id),
        'completed_at', (SELECT max(signed_at) FROM incident_signatures WHERE incident_id = p_id)
    ) INTO v_out;

    RETURN v_out;
END;
$$;

-- ── 10. Grants and RLS ──────────────────────────────────────
ALTER TABLE public.incident_signatures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.incident_signatures FROM anon, PUBLIC;
GRANT SELECT ON public.incident_signatures TO authenticated;
-- No INSERT/UPDATE/DELETE to anyone. Every signature arrives through one of the
-- three definer RPCs above, which is what makes the ordering unbypassable.
--
-- ⚠️ The REVOKE above does not cover `authenticated`, and Supabase's default
-- privileges hand a new public table INSERT/UPDATE/DELETE to that role. Measured
-- straight after applying: has_table_privilege('authenticated', …, 'insert') was
-- TRUE. RLS would still have blocked the write (no INSERT policy exists), but a
-- grant with no policy behind it is exactly the dead grant the 2026-08-14 sweep
-- went looking for, and "RLS is on" is not how this repo reads a privilege.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON public.incident_signatures FROM authenticated, anon, PUBLIC;

CREATE POLICY "admin any role" ON public.incident_signatures
    FOR SELECT TO authenticated USING (is_admin());

CREATE POLICY "parent read own approved" ON public.incident_signatures
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM incident_reports r
                   WHERE r.id = incident_id
                     AND r.status = 'approved'
                     AND parent_owns_student(r.student_id)));

-- ⚠️ Revoke from BOTH anon and PUBLIC, then verify. Supabase's default
-- privileges grant EXECUTE on a new public function directly to anon, so
-- REVOKE ... FROM PUBLIC alone leaves that grant standing (the R26/R27 trap,
-- and the one that bit review_staff_injury_report).
REVOKE ALL ON FUNCTION public.sign_incident_director(bigint, text, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.incident_is_complete(bigint)               FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.sign_incident_director(bigint, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.incident_is_complete(bigint)               TO authenticated;

-- These three are the staff app, which runs on the public anon key and proves
-- itself with a PIN inside the function. Same posture as submit_incident_report
-- and log_child_event.
GRANT EXECUTE ON FUNCTION public.sign_incident_parent(uuid, integer, bigint, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_parent_of_incident(uuid, integer, bigint)  TO anon, authenticated;

-- The print record reads a whole report, so it is never anon-reachable: it
-- checks is_admin() OR parent_owns_student(), both of which need a real session.
REVOKE ALL ON FUNCTION public.incident_print_record(bigint) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.incident_print_record(bigint) TO authenticated;

COMMIT;

-- ============================================================
-- APPLIED AND VERIFIED IN PRODUCTION 2026-08-16
-- ============================================================
-- Grants, measured with has_function_privilege / has_table_privilege:
--   anon -> sign_incident_director        false
--   anon -> incident_print_record         false
--   anon -> incident_is_complete          false
--   anon -> sign_incident_parent          true    (staff app, PIN-gated inside)
--   anon -> submit_incident_report        true    (ditto)
--   anon -> incident_signatures SELECT    false
--   authenticated -> incident_signatures  SELECT only; insert/update revoked
--   submit_incident_report overloads      1       (the ambiguity trap, closed)
--
-- Behavior, in a rolled-back transaction against a real student row:
--   1 parent signature before teacher      raised 23514
--   2 teacher signature alone              complete = false
--   3 director signature before parent     raised 23514
--   4 + parent signature                   complete = false
--   5 + director signature                 complete = true
--   6 UPDATE a stored signature            raised 23514 (append-only trigger)
--   7 second parent signature              raised 23505 (unique role per incident)
--   8 future occurred_at                   clamped to now() by LEAST()
--
-- The print gate, impersonating a real admin from settings.admin_roles so
-- is_admin() returned true — i.e. the most privileged caller there is:
--   0 signatures        ok=false  reason=incomplete
--   teacher only        ok=false  have=["teacher"]
--   teacher + parent    ok=false  have=["teacher","parent"]
--   all three           ok=true   sigs=3, full record returned
-- A non-admin, non-parent caller got NULL at the authorization check, before
-- the gate was even reached.
