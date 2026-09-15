-- ============================================================
-- PROPOSED — NOT APPLIED, NOT APPROVED
-- ============================================================
-- Families → Child → "Add a day": lets the office log a full day's activity
-- (naps, diapers, meals, bottles, notes, supplies) for a child from the admin
-- app, not just the office In/Out mark the Attendance Board already has.
--
-- This file is a PROPOSAL. It is deliberately named PROPOSED_ rather than
-- with a version prefix so it cannot be mistaken for part of the applied
-- sequence and nothing tries to run it. See supabase/migrations/README.md.
--
-- Per AGENTS.md: a schema change on a live childcare system needs Andrew's
-- explicit approval for this specific operation. Nothing that ships today
-- depends on this function existing — the front end that calls it
-- (adminLogChildEventDetail in js/supabase.js, wired into Families → Child in
-- js/admin/admin-family-lookup.js) fails with a plain error toast until this
-- is applied, exactly as any other admin RPC does when it is missing.
--
-- ── Why a new function, not a wider admin_log_child_event() ─
-- admin_log_child_event() (add_classroom_admin_authoring.sql) is the merged
-- Attendance Board's office In/Out mark, and it is DELIBERATELY restricted to
-- check_in/check_out: "an office In/Out mark has no floor observation behind
-- it and must not be able to write [naps, diapers, meals]." That reasoning
-- still holds for the Board. This is a different surface — a director
-- filling in a day's record from the paper file, or completing one a teacher
-- started — so it gets its own function rather than loosening the Board's.
--
-- Mirrors log_child_event() (HISTORICAL_phase1_daily_feed_APPLIED.sql, the
-- staff PIN path) for the event vocabulary, registration lookup and the
-- attendance-record upsert, so an office-entered day and a teacher-entered
-- day read identically in child_day_events and never disagree downstream.
-- Gated on admin_role() IN ('full','restricted'), the same predicate
-- admin_log_child_event/admin_submit_incident_report/admin_log_fire_drill
-- already use — not is_admin() alone, which also passes a read-only 'staff'
-- tier admin.
CREATE OR REPLACE FUNCTION public.admin_log_child_event_detail(
    p_student_id  uuid,
    p_event_type  text,
    p_detail      jsonb       DEFAULT '{}'::jsonb,
    p_occurred_at timestamptz DEFAULT NULL,
    p_care_date   date        DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
DECLARE
    v_at timestamptz; v_date date; v_reg record; v_id bigint; v_detail jsonb;
BEGIN
    IF COALESCE(admin_role(), '') NOT IN ('full', 'restricted') THEN RETURN NULL; END IF;

    IF p_event_type NOT IN ('check_in', 'check_out', 'nap_start', 'nap_end',
                            'diaper', 'bottle', 'meal', 'note', 'supplies') THEN
        RETURN NULL;
    END IF;

    -- No back-dating limit — the whole point is entering a day after the
    -- fact — but never in the future, same clamp admin_log_child_event uses.
    v_at   := LEAST(COALESCE(p_occurred_at, now()), now());
    v_date := COALESCE(p_care_date, (v_at AT TIME ZONE 'America/Chicago')::date);

    SELECT r.id, r.room_id, r.child_name INTO v_reg
    FROM registrations r
    JOIN registration_dates rd ON rd.registration_id = r.id
    JOIN students st ON st.id = p_student_id
    WHERE rd.care_date = v_date AND rd.waitlisted IS NOT TRUE
      AND lower(r.child_name) = lower(st.child_name)
    LIMIT 1;

    -- The caller's own fields (diaper kind, bottle oz, meal amount, supply
    -- item…) win; source/who is always stamped here so a parent or director
    -- reading the timeline later can tell an office entry from a teacher's.
    v_detail := COALESCE(p_detail, '{}'::jsonb)
             || jsonb_build_object('source', 'office',
                                    'recorded_by_email', COALESCE(auth.jwt() ->> 'email', 'admin'));

    INSERT INTO child_day_events (student_id, registration_id, care_date,
                                  event_type, occurred_at, detail)
    VALUES (p_student_id, v_reg.id, v_date, p_event_type, v_at, v_detail)
    RETURNING id INTO v_id;

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
REVOKE ALL ON FUNCTION public.admin_log_child_event_detail(uuid, text, jsonb, timestamptz, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_log_child_event_detail(uuid, text, jsonb, timestamptz, date) TO authenticated;

-- ============================================================
-- APPLY MANUALLY IN THE SUPABASE SQL EDITOR — this repo has no migration
-- runner (see CLAUDE.md, "Apply a DB migration"). After applying:
--   1. verify:
--      select has_function_privilege('anon', 'admin_log_child_event_detail(uuid,text,jsonb,timestamptz,date)', 'execute');           -- expect false
--      select has_function_privilege('authenticated', 'admin_log_child_event_detail(uuid,text,jsonb,timestamptz,date)', 'execute');  -- expect true
--   2. rename this file to the version the database recorded and add it to
--      APPLIED_LEDGER.tsv (npm run migrations:snapshot) — see
--      supabase/migrations/README.md and the note atop check-migrations.js
--      about never inventing a timestamp.
--   3. functional test impersonating a 'restricted'-role admin and a
--      'staff'-role admin from settings.admin_roles: 'restricted' should be
--      able to log a supplies/diaper/nap event for a real student_id;
--      'staff' should get NULL back.
-- ============================================================
