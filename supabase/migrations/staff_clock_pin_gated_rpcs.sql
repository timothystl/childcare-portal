-- ============================================================
-- Close the last permissive anon policy: staff_clock_events
-- ============================================================
-- staff_clock_events has carried anon SELECT/INSERT/UPDATE with `USING (true)`
-- since the kiosk shipped — no staff_id scoping, no ownership check. Verified
-- live: `UPDATE staff_clock_events SET room_id = 'probe'` as anon touched all
-- 1547 rows with no WHERE needed. The public anon key (shipped in every page)
-- could read every staff member's clock history and rewrite any punch.
--
-- clockin.html already captures the staff PIN before touching this table
-- (verify_staff_pin / staff_id_for_pin, same as log_child_event and
-- staff_my_schedule). This migration moves the three direct table operations
-- the kiosk performs — read today's events, clock in, clock out — behind
-- three PIN-gated SECURITY DEFINER RPCs that re-check the PIN on every call,
-- then drops the anon table policies so no path around the RPCs remains.
--
-- staff_id_for_pin() already carries the account lockout + per-IP throttle
-- from verify_staff_pin, so these inherit that for free.
-- ============================================================

-- Today's events for the signed-in staff member only (was: anon could read
-- every staff member's clock history with a bare SELECT).
CREATE OR REPLACE FUNCTION public.staff_clock_status(p_staff_id uuid, p_pin integer, p_work_date date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_staff_id uuid; v_out jsonb;
BEGIN
    v_staff_id := staff_id_for_pin(p_staff_id, p_pin);
    IF v_staff_id IS NULL THEN RETURN NULL; END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', e.id, 'clock_in', e.clock_in, 'clock_out', e.clock_out)
               ORDER BY e.clock_in), '[]'::jsonb)
    INTO v_out
    FROM staff_clock_events e
    WHERE e.staff_id = v_staff_id AND e.work_date = p_work_date;

    RETURN v_out;
END;
$function$;

-- Opens a new shift for the signed-in staff member. The partial unique index
-- from ss12_one_open_clock_event.sql still guards against a double-tap; a
-- second open shift on the same day surfaces as a friendly error instead of
-- a raw 23505.
CREATE OR REPLACE FUNCTION public.staff_clock_in(
    p_staff_id uuid, p_pin integer, p_work_date date, p_room_id text,
    p_outside_fence boolean, p_location_status text, p_device_id text,
    p_lat double precision DEFAULT NULL, p_lon double precision DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_staff_id uuid; v_now timestamptz := now(); v_id uuid;
BEGIN
    v_staff_id := staff_id_for_pin(p_staff_id, p_pin);
    IF v_staff_id IS NULL THEN RETURN NULL; END IF;

    BEGIN
        INSERT INTO staff_clock_events (
            staff_id, work_date, clock_in, clock_out, room_id,
            clock_in_outside_fence, clock_in_location_status, clock_in_device_id,
            clock_in_lat, clock_in_lon
        ) VALUES (
            v_staff_id, p_work_date, v_now, NULL, p_room_id,
            p_outside_fence, p_location_status, p_device_id,
            p_lat, p_lon
        ) RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'Already clocked in for a shift today.' USING ERRCODE = '23505';
    END;

    RETURN jsonb_build_object('id', v_id, 'clock_in', v_now);
END;
$function$;

-- Closes one open shift for the signed-in staff member. p_event_id is
-- re-checked against v_staff_id server-side — the PIN authorizes the caller,
-- it does not let them close a coworker's shift by guessing an id.
CREATE OR REPLACE FUNCTION public.staff_clock_out(
    p_staff_id uuid, p_pin integer, p_event_id uuid,
    p_outside_fence boolean, p_location_status text, p_device_id text,
    p_lat double precision DEFAULT NULL, p_lon double precision DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_staff_id uuid; v_now timestamptz := now(); v_updated uuid;
BEGIN
    v_staff_id := staff_id_for_pin(p_staff_id, p_pin);
    IF v_staff_id IS NULL THEN RETURN NULL; END IF;

    UPDATE staff_clock_events
    SET clock_out = v_now,
        clock_out_outside_fence = p_outside_fence,
        clock_out_location_status = p_location_status,
        clock_out_device_id = p_device_id,
        clock_out_lat = p_lat,
        clock_out_lon = p_lon
    WHERE id = p_event_id AND staff_id = v_staff_id AND clock_out IS NULL
    RETURNING id INTO v_updated;

    IF v_updated IS NULL THEN
        RAISE EXCEPTION 'No open clock-in found. Please try again.';
    END IF;

    RETURN jsonb_build_object('id', v_updated, 'clock_out', v_now);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.staff_clock_status(uuid, integer, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.staff_clock_in(uuid, integer, date, text, boolean, text, text, double precision, double precision) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.staff_clock_out(uuid, integer, uuid, boolean, text, text, double precision, double precision) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.staff_clock_status(uuid, integer, date) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_clock_in(uuid, integer, date, text, boolean, text, text, double precision, double precision) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_clock_out(uuid, integer, uuid, boolean, text, text, double precision, double precision) TO anon, authenticated;

-- The RPCs above are now the only anon path to this table.
DROP POLICY IF EXISTS "anon select clock events" ON staff_clock_events;
DROP POLICY IF EXISTS "anon insert clock events" ON staff_clock_events;
DROP POLICY IF EXISTS "anon update clock events" ON staff_clock_events;

REVOKE SELECT, INSERT, UPDATE ON staff_clock_events FROM anon, PUBLIC;
