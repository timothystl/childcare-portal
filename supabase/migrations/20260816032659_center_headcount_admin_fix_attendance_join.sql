CREATE OR REPLACE FUNCTION public.center_headcount_rows(p_care_date date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions' AS $fn$
DECLARE v_date date; v_children jsonb; v_staff jsonb;
BEGIN
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
    ),
    -- ⚠️ attendance_records has NO student_id — it keys on child_name (and a
    -- registration_id). Same name-matching the rest of this function already
    -- does for registrations; lowered on both sides so casing cannot split a
    -- child from their own absence mark.
    marked AS (
        SELECT DISTINCT ON (lower(ar.child_name))
               lower(ar.child_name) AS name_key, ar.status
        FROM attendance_records ar
        WHERE ar.care_date = v_date
        ORDER BY lower(ar.child_name), ar.recorded_at DESC
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
               le.occurred_at AS last_event_at,
               st.allergies,
               mk.status AS marked
        FROM everyone ev
        LEFT JOIN last_ev le ON le.student_id = ev.student_id
        LEFT JOIN students st ON st.id = ev.student_id
        LEFT JOIN marked mk ON mk.name_key = lower(ev.child_name)
    ) x;

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
$fn$;

REVOKE ALL ON FUNCTION public.center_headcount_rows(date) FROM anon, authenticated, PUBLIC;
