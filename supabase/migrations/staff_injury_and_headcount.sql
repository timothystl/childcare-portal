-- ============================================================
-- Staff injury reports (workers' comp) + center-wide head count
-- ============================================================
-- Two things the portal could not do, both asked for on 2026-08-14:
--
--   1. A staff member who gets hurt at work has nowhere to say so. The one
--      incident form we have is `incident_reports`, and its `student_id` is
--      NOT NULL — a staff injury is not a child incident wearing a different
--      hat, and this migration deliberately does NOT try to make it one. See
--      the note above staff_injury_reports.
--
--   2. A fire drill needs a count of every person in the building, and the
--      portal only ever counted one room at a time. `center_headcount()`
--      answers "who is in this building right now", and `fire_drills` keeps
--      the answer, because the count is worthless the moment the drill is over
--      unless somebody wrote it down.
--
-- Same security posture as the rest of the staff app: staff hold no Supabase
-- account, so every write is a PIN-gated SECURITY DEFINER RPC with the
-- search_path pinned, and there are no table grants for anon behind any of it.

-- ============================================================
-- 1. STAFF INJURY REPORTS
-- ============================================================
-- ⚠️ WHY NOT REUSE incident_reports. Three reasons, any one of them enough:
--
--   * incident_reports carries a "parent read approved" policy keyed on
--     parent_owns_student. A staff injury has no student, and one mistake in
--     that predicate would put an employee's medical detail in front of
--     families. Separate tables mean no such mistake is expressible.
--   * The review verb is different. Approving a child incident PUBLISHES it to
--     the family. There is no family here — the director's act is reporting it
--     to the insurer, which is a different button with a different consequence.
--   * The fields are different, and they are the ones a workers' comp carrier
--     asks for: did they seek treatment, where, was there a witness, did they
--     lose time from work.
--
-- ⚠️ reported_at IS A LEGAL CLOCK, not a display timestamp. Missouri gives the
-- employer 30 days from knowledge of the injury to file the First Report with
-- the Division (RSMo 287.380), and the employee 30 days to notify the employer
-- in writing (287.420). That is what this row is — the written notification,
-- date-stamped by the database rather than by whoever remembers. The director's
-- queue ages from it and nags, which is the whole point of storing it.

CREATE TABLE IF NOT EXISTS public.staff_injury_reports (
    id                   bigserial PRIMARY KEY,

    -- Who was hurt. ON DELETE RESTRICT, not CASCADE: removing a staff row must
    -- not destroy an injury record the carrier or the Division may need years
    -- later. Same reasoning as incident_reports.student_id.
    staff_id             uuid NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
    -- Denormalized on purpose. A report is a record; if the row is ever
    -- removed it must still say whose injury this was.
    staff_name           text,

    occurred_at          timestamptz NOT NULL DEFAULT now(),
    work_date            date NOT NULL,
    location             text,
    body_area            text,
    description          text NOT NULL,     -- what happened
    action_taken         text NOT NULL,     -- what was done at the time
    witness              text,

    -- The carrier's first question, every time.
    sought_treatment     text NOT NULL DEFAULT 'none'
                            CHECK (sought_treatment IN
                                ('none','onsite_first_aid','clinic_er','declined','later')),
    treatment_facility   text,
    lost_time            boolean NOT NULL DEFAULT false,

    -- ⚠️ The injured person may not be the one filing. Someone with a hurt
    -- wrist should not have to type the form, and someone who has gone to
    -- urgent care cannot. reported_by_* is the PIN holder; staff_id is the
    -- person who was hurt, and they are allowed to differ.
    reported_by_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
    reported_by_name     text,
    reported_at          timestamptz NOT NULL DEFAULT now(),

    status               text NOT NULL DEFAULT 'reported'
                            CHECK (status IN ('reported','acknowledged','filed','closed')),
    reviewed_by          text,
    reviewed_at          timestamptz,
    director_notes       text,
    insurer_claim_ref    text,
    insurer_reported_at  timestamptz,

    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS staff_injury_status_idx ON public.staff_injury_reports (status, reported_at DESC);
CREATE INDEX IF NOT EXISTS staff_injury_staff_idx  ON public.staff_injury_reports (staff_id, occurred_at DESC);

ALTER TABLE public.staff_injury_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_injury_reports FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.staff_injury_reports TO authenticated;
-- No DELETE grant for anyone, and deliberately no parent-facing policy of any
-- kind — not even a restrictive one. There is nothing here a family may read.
DROP POLICY IF EXISTS "admin only" ON public.staff_injury_reports;
CREATE POLICY "admin only" ON public.staff_injury_reports
    FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- ── Staff write path ────────────────────────────────────────
-- Returns NULL on a bad PIN rather than raising, so a wrong PIN is
-- indistinguishable from any other failure. Matches log_child_event and
-- submit_incident_report. Lockout and throttling come free via
-- staff_id_for_pin -> verify_staff_pin.
CREATE OR REPLACE FUNCTION public.submit_staff_injury_report(
    p_staff_id           uuid,     -- the PIN holder (who is filing)
    p_pin                integer,
    p_description        text,
    p_action_taken       text,
    p_injured_staff_id   uuid    DEFAULT NULL,   -- NULL = filing for yourself
    p_occurred_at        timestamptz DEFAULT NULL,
    p_location           text    DEFAULT NULL,
    p_body_area          text    DEFAULT NULL,
    p_witness            text    DEFAULT NULL,
    p_sought_treatment   text    DEFAULT 'none',
    p_treatment_facility text    DEFAULT NULL,
    p_lost_time          boolean DEFAULT false
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
DECLARE
    v_staff_id uuid; v_filer_name text;
    v_injured uuid;  v_injured_name text;
    v_at timestamptz; v_id bigint;
BEGIN
    v_staff_id := staff_id_for_pin(p_staff_id, p_pin);
    IF v_staff_id IS NULL THEN RETURN NULL; END IF;

    IF COALESCE(btrim(p_description), '') = '' OR COALESCE(btrim(p_action_taken), '') = '' THEN
        RETURN NULL;
    END IF;
    IF COALESCE(p_sought_treatment, 'none') NOT IN
        ('none','onsite_first_aid','clinic_er','declined','later') THEN
        RETURN NULL;
    END IF;

    -- ⚠️ The injured staff member is taken from the argument but must be a real
    -- active staff row, or it falls back to the filer. Left unchecked, a bad id
    -- from the client would either fail the FK at insert (losing the report) or
    -- file an injury against nobody.
    v_injured := COALESCE(p_injured_staff_id, v_staff_id);
    SELECT name INTO v_injured_name FROM staff WHERE id = v_injured AND active = true;
    IF v_injured_name IS NULL THEN
        v_injured := v_staff_id;
        SELECT name INTO v_injured_name FROM staff WHERE id = v_injured;
    END IF;

    SELECT name INTO v_filer_name FROM staff WHERE id = v_staff_id;

    -- An injury reported days later is normal and must be recordable, but the
    -- occurrence cannot be in the future.
    v_at := LEAST(COALESCE(p_occurred_at, now()), now());

    INSERT INTO staff_injury_reports (
        staff_id, staff_name, occurred_at, work_date, location, body_area,
        description, action_taken, witness, sought_treatment, treatment_facility,
        lost_time, reported_by_staff_id, reported_by_name, status
    ) VALUES (
        v_injured, v_injured_name, v_at,
        (v_at AT TIME ZONE 'America/Chicago')::date,
        nullif(btrim(p_location), ''), nullif(btrim(p_body_area), ''),
        btrim(p_description), btrim(p_action_taken), nullif(btrim(p_witness), ''),
        COALESCE(p_sought_treatment, 'none'), nullif(btrim(p_treatment_facility), ''),
        COALESCE(p_lost_time, false), v_staff_id, v_filer_name,
        'reported'          -- only the director moves it past this
    ) RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.submit_staff_injury_report(
    uuid, integer, text, text, uuid, timestamptz, text, text, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_staff_injury_report(
    uuid, integer, text, text, uuid, timestamptz, text, text, text, text, text, boolean) TO anon, authenticated;

-- ── Director review ─────────────────────────────────────────
-- Admin-only, and it stamps the reviewer from the JWT so a status can never be
-- advanced without a name attached to it. Same shape as review_incident_report.
CREATE OR REPLACE FUNCTION public.review_staff_injury_report(
    p_id bigint, p_status text, p_notes text DEFAULT NULL,
    p_claim_ref text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
DECLARE v_who text;
BEGIN
    IF NOT is_admin() THEN RETURN false; END IF;
    IF p_status NOT IN ('reported','acknowledged','filed','closed') THEN RETURN false; END IF;

    v_who := COALESCE(auth.jwt() ->> 'email', 'admin');

    UPDATE staff_injury_reports SET
        status              = p_status,
        director_notes      = COALESCE(nullif(btrim(p_notes), ''), director_notes),
        insurer_claim_ref   = COALESCE(nullif(btrim(p_claim_ref), ''), insurer_claim_ref),
        reviewed_by         = v_who,
        reviewed_at         = now(),
        -- Stamped once, when it is first marked filed. Re-saving a filed report
        -- must not move the date the carrier was actually told.
        insurer_reported_at = CASE WHEN p_status = 'filed' AND insurer_reported_at IS NULL
                                   THEN now() ELSE insurer_reported_at END
    WHERE id = p_id;

    RETURN FOUND;
END;
$$;
-- ⚠️ FROM anon AS WELL AS FROM PUBLIC. Supabase's default privileges grant
-- EXECUTE on a new public function directly to anon, so revoking PUBLIC alone
-- leaves that direct grant in place — the R26/R27 trap, inverted. Verified
-- after applying: the first check came back anon=true and needed this line.
REVOKE EXECUTE ON FUNCTION public.review_staff_injury_report(bigint, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_staff_injury_report(bigint, text, text, text) TO authenticated;
-- Deliberately NOT anon: this is the director's desk, not the staff app's.
-- is_admin() already refuses an anon caller, so the grant was never a live
-- hole, but a function the staff app can call is a function that will one day
-- be assumed callable.

-- ============================================================
-- 2. CENTER HEAD COUNT
-- ============================================================
-- ⚠️ "PRESENT" IS NOT "HAS A CHECK-IN EVENT". list_room_children computed
-- checked_in as EXISTS(check_in), which stays true after a child goes home. On
-- a roster that is a cosmetic wrong. On a fire drill sheet it sends a teacher
-- back into a building looking for a child who left at noon, which is the exact
-- failure the count exists to prevent. Present means the LATEST attendance
-- event today is a check-in.
--
-- Children with an event but no booking (drop-ins) are included. log_child_event
-- accepts them by design, and a child physically in the building must appear on
-- an evacuation count whatever the paperwork says.

CREATE OR REPLACE FUNCTION public.center_headcount(
    p_staff_id uuid, p_pin integer, p_care_date date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
DECLARE v_staff_id uuid; v_date date; v_children jsonb; v_staff jsonb;
BEGIN
    v_staff_id := staff_id_for_pin(p_staff_id, p_pin);
    IF v_staff_id IS NULL THEN RETURN NULL; END IF;
    v_date := COALESCE(p_care_date, (now() AT TIME ZONE 'America/Chicago')::date);

    WITH last_ev AS (
        SELECT DISTINCT ON (e.student_id)
               e.student_id, e.event_type, e.occurred_at
        FROM child_day_events e
        WHERE e.care_date = v_date AND e.event_type IN ('check_in','check_out')
        ORDER BY e.student_id, e.occurred_at DESC, e.id DESC
    ),
    booked AS (
        SELECT DISTINCT ON (st.id) st.id AS student_id, st.child_name, r.room_id
        FROM registrations r
        JOIN registration_dates rd ON rd.registration_id = r.id
        JOIN students st ON lower(st.child_name) = lower(r.child_name)
        WHERE rd.care_date = v_date AND rd.waitlisted IS NOT TRUE
        ORDER BY st.id, r.id DESC
    ),
    -- In the building without a booking for today. Their room is whatever the
    -- office last put them in; 'unassigned' if we genuinely do not know, which
    -- surfaces in the UI rather than hiding the child.
    dropins AS (
        SELECT st.id AS student_id, st.child_name,
               COALESCE(
                   st.room_override,
                   (SELECT r2.room_id FROM registrations r2
                     WHERE lower(r2.child_name) = lower(st.child_name)
                     ORDER BY r2.id DESC LIMIT 1),
                   'unassigned'
               ) AS room_id
        FROM last_ev le
        JOIN students st ON st.id = le.student_id
        WHERE NOT EXISTS (SELECT 1 FROM booked b WHERE b.student_id = le.student_id)
    ),
    everyone AS (
        SELECT student_id, child_name, room_id, false AS dropin FROM booked
        UNION ALL
        SELECT student_id, child_name, room_id, true  AS dropin FROM dropins
    )
    SELECT COALESCE(jsonb_agg(x ORDER BY x.room_id, x.child_name), '[]'::jsonb)
      INTO v_children
    FROM (
        SELECT ev.student_id, ev.child_name, ev.room_id, ev.dropin,
               CASE
                   WHEN le.event_type = 'check_in'  THEN 'present'
                   WHEN le.event_type = 'check_out' THEN 'left'
                   ELSE 'not_arrived'
               END AS attendance_status,
               le.occurred_at AS last_event_at
        FROM everyone ev
        LEFT JOIN last_ev le ON le.student_id = ev.student_id
    ) x;

    -- Staff in the building = an open clock event for today. SS12 already
    -- guarantees at most one open event per staff member, but DISTINCT ON keeps
    -- this correct even if that constraint is ever relaxed.
    SELECT COALESCE(jsonb_agg(y ORDER BY y.room_id NULLS LAST, y.staff_name), '[]'::jsonb)
      INTO v_staff
    FROM (
        SELECT DISTINCT ON (ce.staff_id)
               ce.staff_id, s.name AS staff_name,
               COALESCE(ce.room_id, s.room_id) AS room_id,
               ce.clock_in
        FROM staff_clock_events ce
        JOIN staff s ON s.id = ce.staff_id
        WHERE ce.work_date = v_date AND ce.clock_out IS NULL
        ORDER BY ce.staff_id, ce.clock_in DESC
    ) y;

    RETURN jsonb_build_object(
        'as_of',      now(),
        'care_date',  v_date,
        'children',   v_children,
        'staff',      v_staff
    );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.center_headcount(uuid, integer, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.center_headcount(uuid, integer, date) TO anon, authenticated;

-- ── The same correction, on the room roster ─────────────────
-- Left alone, the roster would keep saying "In" for a child the head count
-- calls "left", and staff would have two screens disagreeing about the one
-- fact that matters. `checked_in` is KEPT with its original meaning so a
-- browser still running yesterday's bundle does not break; the new
-- attendance_status is what the updated app reads.
--
-- Adding a column to a RETURNS TABLE needs a drop, not a replace. It runs
-- inside this migration's implicit transaction, so the window is not
-- observable by the app.
DROP FUNCTION IF EXISTS public.list_room_children(uuid, integer, text, date);
CREATE FUNCTION public.list_room_children(
    p_staff_id uuid, p_pin integer, p_room_id text, p_care_date date DEFAULT NULL)
RETURNS TABLE (student_id uuid, child_name text, allergies jsonb, care_notes text,
               photo_release boolean, checked_in boolean, allergies_reviewed boolean,
               attendance_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
DECLARE v_staff_id uuid; v_date date;
BEGIN
    v_staff_id := staff_id_for_pin(p_staff_id, p_pin);
    IF v_staff_id IS NULL THEN RETURN; END IF;
    v_date := COALESCE(p_care_date, (now() AT TIME ZONE 'America/Chicago')::date);

    RETURN QUERY
    WITH last_ev AS (
        SELECT DISTINCT ON (e.student_id) e.student_id, e.event_type
        FROM child_day_events e
        WHERE e.care_date = v_date AND e.event_type IN ('check_in','check_out')
        ORDER BY e.student_id, e.occurred_at DESC, e.id DESC
    )
    SELECT DISTINCT ON (st.id)
        st.id, st.child_name, st.allergies, st.care_notes, st.photo_release,
        EXISTS (SELECT 1 FROM child_day_events e2
                WHERE e2.student_id = st.id AND e2.care_date = v_date
                  AND e2.event_type = 'check_in') AS checked_in,
        (st.allergies_reviewed_at IS NOT NULL) AS allergies_reviewed,
        CASE
            WHEN le.event_type = 'check_in'  THEN 'present'
            WHEN le.event_type = 'check_out' THEN 'left'
            ELSE 'not_arrived'
        END AS attendance_status
    FROM registrations r
    JOIN registration_dates rd ON rd.registration_id = r.id
    JOIN students st ON lower(st.child_name) = lower(r.child_name)
    LEFT JOIN last_ev le ON le.student_id = st.id
    WHERE rd.care_date = v_date AND rd.waitlisted IS NOT TRUE AND r.room_id = p_room_id
    ORDER BY st.id, st.child_name;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.list_room_children(uuid, integer, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_room_children(uuid, integer, text, date) TO anon, authenticated;

-- ============================================================
-- 3. FIRE DRILL RECORDS
-- ============================================================
-- Missouri licensing requires fire drills to be held monthly and the records
-- kept (19 CSR 30-62). Today they are held and written on paper. The count is
-- already on the phone at the moment it is taken, so recording it is one tap
-- and the compliance record becomes a by-product instead of a chore.
--
-- ⚠️ `snapshot` is the point of the table, not decoration. It stores the names
-- and rooms as they were at the moment of the drill. Counts alone cannot answer
-- "who was in the building on March 3rd", and re-deriving it later gives the
-- wrong answer the first time somebody edits that day's registrations.

CREATE TABLE IF NOT EXISTS public.fire_drills (
    id                   bigserial PRIMARY KEY,
    drill_date           date NOT NULL,
    started_at           timestamptz NOT NULL DEFAULT now(),
    drill_type           text NOT NULL DEFAULT 'fire'
                            CHECK (drill_type IN ('fire','tornado','lockdown','earthquake','other')),
    evacuation_seconds   integer CHECK (evacuation_seconds IS NULL OR evacuation_seconds >= 0),

    children_present     integer NOT NULL DEFAULT 0,
    children_accounted   integer NOT NULL DEFAULT 0,
    staff_present        integer NOT NULL DEFAULT 0,
    staff_accounted      integer NOT NULL DEFAULT 0,

    snapshot             jsonb NOT NULL DEFAULT '{}'::jsonb,
    conducted_by_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
    conducted_by_name    text,
    notes                text,
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fire_drills_date_idx ON public.fire_drills (drill_date DESC);

ALTER TABLE public.fire_drills ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fire_drills FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.fire_drills TO authenticated;
-- No DELETE: a drill that happened cannot be un-held, and a licensing record
-- that can be quietly removed is not a record.
DROP POLICY IF EXISTS "admin only" ON public.fire_drills;
CREATE POLICY "admin only" ON public.fire_drills
    FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

CREATE OR REPLACE FUNCTION public.log_fire_drill(
    p_staff_id uuid, p_pin integer, p_payload jsonb)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
DECLARE v_staff_id uuid; v_name text; v_id bigint; v_type text;
BEGIN
    v_staff_id := staff_id_for_pin(p_staff_id, p_pin);
    IF v_staff_id IS NULL THEN RETURN NULL; END IF;

    v_type := COALESCE(p_payload ->> 'drill_type', 'fire');
    IF v_type NOT IN ('fire','tornado','lockdown','earthquake','other') THEN
        v_type := 'other';
    END IF;

    SELECT name INTO v_name FROM staff WHERE id = v_staff_id;

    -- ⚠️ Explicit allow-list, not `p_payload` splatted into the row. Same
    -- reasoning as submit_waitlist_application: a jsonb argument is client
    -- input, and every column it may set is named here on purpose. drill_date,
    -- started_at and the conductor are server-side and cannot be supplied.
    INSERT INTO fire_drills (
        drill_date, drill_type, evacuation_seconds,
        children_present, children_accounted, staff_present, staff_accounted,
        snapshot, conducted_by_staff_id, conducted_by_name, notes
    ) VALUES (
        (now() AT TIME ZONE 'America/Chicago')::date,
        v_type,
        NULLIF(p_payload ->> 'evacuation_seconds', '')::integer,
        COALESCE((p_payload ->> 'children_present')::integer, 0),
        COALESCE((p_payload ->> 'children_accounted')::integer, 0),
        COALESCE((p_payload ->> 'staff_present')::integer, 0),
        COALESCE((p_payload ->> 'staff_accounted')::integer, 0),
        COALESCE(p_payload -> 'snapshot', '{}'::jsonb),
        v_staff_id, v_name,
        NULLIF(btrim(COALESCE(p_payload ->> 'notes', '')), '')
    ) RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.log_fire_drill(uuid, integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_fire_drill(uuid, integer, jsonb) TO anon, authenticated;

-- ============================================================
-- APPLIED TO PRODUCTION 2026-08-14, and VERIFIED AFTER APPLYING
-- (end to end in one transaction, aborted by RAISE so nothing persisted —
--  re-checked afterwards: zero probe rows left behind)
-- ============================================================
-- PIN gate:
--   bad PIN -> NULL from all three of center_headcount,
--              submit_staff_injury_report and log_fire_drill (never an error)
--
-- center_headcount, with a probe staff member and three seeded events:
--   child checked in                 -> 'present'
--   child checked in THEN out        -> 'left'      <- the whole point; the old
--                                                      checked_in flag said "In"
--   child booked, no event           -> 'not_arrived'
--   totals 56 booked / 1 present / 1 left / 54 not arrived
--   staff = open clock events today, 13 real + the probe
--
-- submit_staff_injury_report:
--   occurred_at passed as now() + 2 days -> stored as now() (clamped)
--   status 'reported'; lost_time and treatment_facility round-trip
--   injured defaults to the PIN holder when p_injured_staff_id is NULL
--
-- log_fire_drill, INJECTION TEST — payload carried
--   drill_date '1999-01-01' and conducted_by_name 'SHOULD BE IGNORED':
--   stored drill_date = today (server-side) and conductor = the PIN holder.
--   drill_type and evacuation_seconds round-trip.
--
-- Grants:
--   anon SELECT on staff_injury_reports -> false
--   anon SELECT on fire_drills          -> false
--   anon EXECUTE center_headcount       -> true  (the staff app has no account)
--   anon EXECUTE review_staff_injury    -> false (see the note above the revoke)
--
-- ⚠️ OPERATIONAL REALITY AT THE TIME OF APPLYING. child_day_events and
-- attendance_records were both EMPTY — not one check-in has ever been recorded,
-- because the staff app shipped 2026-08-12 and the habit does not exist yet. So
-- center_headcount answers "0 present, 56 booked" until staff start tapping
-- Check in. The UI is built around that fact rather than around the happy path:
-- it falls back to the booked roster, says so in a banner, and makes the
-- tick-off — not the check-in data — the thing the drill record is built from.
