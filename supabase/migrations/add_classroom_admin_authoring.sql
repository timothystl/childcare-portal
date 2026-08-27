-- ============================================================
-- Admin-authored writes for the Classroom tab consolidation
-- (design handoff: Classroom Tab Redesign, 2026-08-27)
-- ============================================================
-- Three self-serve paths for the director, alongside the existing staff-app
-- ones — never replacing them:
--
--   1. admin_log_child_event — the merged Attendance Board's office In/Out
--      buttons. Writes into child_day_events, the SAME table the teacher
--      app's own check-in writes to (log_child_event), so the parent app's
--      daily record and the office's manual mark can never disagree — the
--      open question the design handoff flagged, resolved by not building a
--      second table. Gated on admin_role(), not a PIN: this runs from an
--      authenticated admin session, not a shared staff phone.
--
--   2. admin_submit_incident_report — Incident Reports' "+ Write a report".
--      A director-authored report has no teacher filing it, so she IS
--      signature 1 — the same rule submit_incident_report already applies to
--      a teacher ("filing IS signing"), just from the office instead of the
--      floor. Nothing about the three-signature order-guard trigger changes:
--      this still inserts a 'teacher'-role signature first, and that trigger
--      enforces the rest exactly as it does for a staff-filed report.
--
--   3. admin_log_fire_drill — Fire Drills' "+ Log a Drill", for a drill the
--      director ran herself or is entering from a paper record, alongside
--      the existing staff-app kiosk path (log_fire_drill).
--
-- None of these touch the PIN-gated staff versions, which are unchanged —
-- this is a second front door, not a replacement for the first.
--
-- ⚠️ GATED ON admin_role() IN ('full','restricted'), NOT is_admin() ALONE.
-- CLAUDE.md documents the 'staff' admin-portal role as "Classrooms tab only
-- (read-only roster view)". is_admin() alone would let a 'staff'-tier admin
-- login mark attendance, file incidents and log drills — real writes, not a
-- read-only roster. admin_role() is what the SX6/NEW-6 findings elsewhere in
-- this schema already argue every sensitive gate should use instead of
-- browser-side hiding; these are new functions, so there is no reason to
-- ship them with the weaker pattern on day one.

-- ── 1. Office In/Out on the merged Attendance Board ─────────
CREATE OR REPLACE FUNCTION public.admin_log_child_event(
    p_student_id  uuid,
    p_event_type  text,
    p_occurred_at timestamptz DEFAULT NULL,
    p_care_date   date        DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
DECLARE
    v_at timestamptz; v_date date; v_reg record; v_id bigint; v_detail jsonb;
BEGIN
    IF COALESCE(admin_role(), '') NOT IN ('full', 'restricted') THEN RETURN NULL; END IF;

    -- The board only ever marks a child in or out. Naps, diapers, meals stay
    -- the teacher app's — an office In/Out mark has no floor observation
    -- behind it and must not be able to write those.
    IF p_event_type NOT IN ('check_in', 'check_out') THEN RETURN NULL; END IF;

    v_at   := LEAST(COALESCE(p_occurred_at, now()), now());
    v_date := COALESCE(p_care_date, (v_at AT TIME ZONE 'America/Chicago')::date);

    SELECT r.id, r.room_id, r.child_name INTO v_reg
    FROM registrations r
    JOIN registration_dates rd ON rd.registration_id = r.id
    JOIN students st ON st.id = p_student_id
    WHERE rd.care_date = v_date AND rd.waitlisted IS NOT TRUE
      AND lower(r.child_name) = lower(st.child_name)
    LIMIT 1;

    v_detail := jsonb_build_object('source', 'office',
                                    'recorded_by_email', COALESCE(auth.jwt() ->> 'email', 'admin'));

    INSERT INTO child_day_events (student_id, registration_id, care_date,
                                  event_type, occurred_at, detail)
    VALUES (p_student_id, v_reg.id, v_date, p_event_type, v_at, v_detail)
    RETURNING id INTO v_id;

    -- Same downstream effect as log_child_event: a check-in also marks the
    -- office's own present/absent record, so "marked" (the board's Absent
    -- tile) and attendance_status (present/left/not_arrived) can never show a
    -- child as both checked in and marked absent.
    IF p_event_type = 'check_in' AND v_reg.id IS NOT NULL THEN
        INSERT INTO attendance_records (registration_id, care_date, room_id,
                                        child_name, status, recorded_by)
        VALUES (v_reg.id, v_date, v_reg.room_id, v_reg.child_name, 'present', 'office')
        ON CONFLICT (registration_id, care_date)
        DO UPDATE SET status = 'present', recorded_at = now();
    END IF;

    RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_log_child_event(uuid, text, timestamptz, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_log_child_event(uuid, text, timestamptz, date) TO authenticated;

-- ── 2. Director-authored incident report ────────────────────
CREATE OR REPLACE FUNCTION public.admin_submit_incident_report(
    p_student_id    uuid,
    p_incident_type text,
    p_description   text,
    p_action_taken  text,
    p_incident_kind text        DEFAULT NULL,
    p_location      text        DEFAULT NULL,
    p_body_area     text        DEFAULT NULL,
    p_occurred_at   timestamptz DEFAULT NULL,
    p_signed_name   text        DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
DECLARE v_at timestamptz; v_who text; v_id bigint;
BEGIN
    IF COALESCE(admin_role(), '') NOT IN ('full', 'restricted') THEN RETURN NULL; END IF;

    IF p_incident_type NOT IN ('injury', 'illness', 'behavior', 'other') THEN RETURN NULL; END IF;
    IF COALESCE(btrim(p_description), '') = '' OR COALESCE(btrim(p_action_taken), '') = '' THEN
        RETURN NULL;
    END IF;

    -- No back-date limit, matching submit_incident_report — only bound is
    -- never in the future.
    v_at  := LEAST(COALESCE(p_occurred_at, now()), now());
    v_who := COALESCE(nullif(btrim(p_signed_name), ''), auth.jwt() ->> 'email', 'Director');

    INSERT INTO incident_reports (
        student_id, care_date, occurred_at, filed_at, incident_type, incident_kind,
        location, body_area, description, action_taken, reported_by_name, status
    ) VALUES (
        p_student_id, (v_at AT TIME ZONE 'America/Chicago')::date, v_at, now(),
        p_incident_type, nullif(btrim(p_incident_kind), ''),
        nullif(btrim(p_location), ''), nullif(btrim(p_body_area), ''),
        btrim(p_description), btrim(p_action_taken), v_who,
        'submitted'          -- never 'approved'; the print gate still needs all 3 signatures
    ) RETURNING id INTO v_id;

    -- Signature 1. She is filing it, so she is signing it — same rule as a
    -- teacher's own report. The existing order-guard trigger on
    -- incident_signatures enforces everything after this unchanged: a parent
    -- signature still cannot be recorded before this one exists, and this
    -- report still needs the parent's pickup signature before the director's
    -- own sign-off (sign_incident_director) can close it.
    INSERT INTO incident_signatures (incident_id, role, signed_name)
    VALUES (v_id, 'teacher', v_who);

    RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_submit_incident_report(
    uuid, text, text, text, text, text, text, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_submit_incident_report(
    uuid, text, text, text, text, text, text, timestamptz, text) TO authenticated;

-- ── 3. Director-logged fire drill ───────────────────────────
CREATE OR REPLACE FUNCTION public.admin_log_fire_drill(p_payload jsonb)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
DECLARE v_id bigint; v_type text; v_who text;
BEGIN
    IF COALESCE(admin_role(), '') NOT IN ('full', 'restricted') THEN RETURN NULL; END IF;

    v_type := COALESCE(p_payload ->> 'drill_type', 'fire');
    IF v_type NOT IN ('fire', 'tornado', 'lockdown', 'earthquake', 'other') THEN
        v_type := 'other';
    END IF;
    v_who := COALESCE(auth.jwt() ->> 'email', 'Director');

    -- Explicit allow-list, matching log_fire_drill — drill_date and the
    -- conductor are server-side and cannot be supplied by the payload.
    INSERT INTO fire_drills (
        drill_date, drill_type, evacuation_seconds,
        children_present, children_accounted, staff_present, staff_accounted,
        snapshot, conducted_by_name, notes
    ) VALUES (
        (now() AT TIME ZONE 'America/Chicago')::date,
        v_type,
        NULLIF(p_payload ->> 'evacuation_seconds', '')::integer,
        COALESCE((p_payload ->> 'children_present')::integer, 0),
        COALESCE((p_payload ->> 'children_accounted')::integer, 0),
        COALESCE((p_payload ->> 'staff_present')::integer, 0),
        COALESCE((p_payload ->> 'staff_accounted')::integer, 0),
        COALESCE(p_payload -> 'snapshot', '{}'::jsonb),
        v_who,
        NULLIF(btrim(COALESCE(p_payload ->> 'notes', '')), '')
    ) RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_log_fire_drill(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_log_fire_drill(jsonb) TO authenticated;

-- ============================================================
-- APPLY MANUALLY IN THE SUPABASE SQL EDITOR — this repo has no migration
-- runner (see CLAUDE.md, "Apply a DB migration"). After applying, verify:
--   select has_function_privilege('anon', 'admin_log_child_event(uuid,text,timestamptz,date)', 'execute');           -- expect false
--   select has_function_privilege('authenticated', 'admin_log_child_event(uuid,text,timestamptz,date)', 'execute');  -- expect true
--   (repeat for admin_submit_incident_report and admin_log_fire_drill)
-- and a rolled-back functional test impersonating a 'restricted'-role admin
-- and a 'staff'-role admin from settings.admin_roles: 'restricted' should
-- succeed, 'staff' should get NULL back from all three.
-- ============================================================
