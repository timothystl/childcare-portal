-- ============================================================
-- SECURITY DEFINER CRITICAL HOTFIX
-- Smallest fix for the three Critical findings from the 2026-09-08
-- SECURITY DEFINER function audit. Each is additive/self-contained:
-- no grant changes, no RLS changes, no client-visible behavior change
-- for anyone who was already using these correctly.
-- ============================================================

-- ------------------------------------------------------------
-- 1. log_admin_action() had NO admin check at all.
--
-- Every sibling admin_* function in this schema opens with an
-- admin_role() gate; this one, the audit-log writer itself, did not.
-- Since Option B (2026-08-12) gave parents real `authenticated`
-- sessions too, any signed-in parent could call this RPC directly and
-- insert an arbitrary, permanently-stored, falsified entry into the
-- one table this app's own comments call "tamper-evident."
--
-- Fix: add the same guard every sibling function already has. No
-- grant change — `authenticated` still needs EXECUTE for real admins
-- to use it; the check is now inside the body where it belongs.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_admin_action(
    p_action    text,
    p_entity    text,
    p_entity_id text  DEFAULT NULL,
    p_details   jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF NOT is_admin() THEN
        RETURN;
    END IF;

    INSERT INTO public.admin_audit_log (admin_email, action, entity, entity_id, details)
    VALUES (COALESCE(auth.email(), 'unknown'), p_action, p_entity, p_entity_id, p_details);
END;
$$;

-- ------------------------------------------------------------
-- 2 & 3. list_my_time_off_requests(p_pin) / submit_time_off_request(p_pin, ...)
-- identified staff by scanning EVERY active staff member's bcrypt hash
-- against a bare 4-digit PIN, with no staff id and no lockout of any
-- kind (no staff_id_for_pin(), no pin_attempts_blocked()/
-- record_pin_attempt()). With ~30 active staff and a 10,000-value PIN
-- space, an unauthenticated script had roughly a 1-in-300 chance per
-- guess of landing on *some* real staff member, fully automatable with
-- nothing to stop it. The repo's own migration history
-- (staff_signin_name_then_pin_APPLIED.sql, staff_shift_swaps_and_
-- my_shifts.sql) already fixed this exact pattern everywhere else and
-- named these two functions as the unfixed exception.
--
-- Fix: take p_staff_id like every sibling staff RPC
-- (staff_my_schedule, answer_shift_swap, propose_shift_swap, …) and
-- verify the PIN through staff_id_for_pin(), which inherits the real
-- per-account lockout + IP throttle + global backstop. Parameter list
-- changes, so the old signatures are dropped and recreated rather than
-- REPLACEd; grants are re-declared explicitly to match what was live
-- (anon + authenticated — the kiosk has no session, PIN is the
-- credential) rather than relying on the schema's default privileges.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.list_my_time_off_requests(integer);
DROP FUNCTION IF EXISTS public.submit_time_off_request(integer, date[], boolean, text, text);

CREATE FUNCTION public.list_my_time_off_requests(p_staff_id uuid, p_pin integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_staff_id uuid;
    v_rows     jsonb;
BEGIN
    v_staff_id := staff_id_for_pin(p_staff_id, p_pin);
    IF v_staff_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(jsonb_agg(r ORDER BY r.submitted_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
        SELECT id, off_dates, recurring, reason, note, status, submitted_at
        FROM staff_time_off_requests
        WHERE staff_id = v_staff_id
          AND status <> 'declined'
          AND (recurring = true OR off_dates[array_upper(off_dates, 1)] >= CURRENT_DATE - 7)
        ORDER BY submitted_at DESC
        LIMIT 20
    ) r;

    RETURN v_rows;
END;
$$;

CREATE FUNCTION public.submit_time_off_request(
    p_staff_id  uuid,
    p_pin       integer,
    p_dates     date[],
    p_recurring boolean DEFAULT false,
    p_reason    text    DEFAULT '',
    p_note      text    DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_staff_id uuid;
    v_weekday  smallint;
    v_id       bigint;
BEGIN
    IF p_dates IS NULL OR array_length(p_dates, 1) IS NULL THEN
        RAISE EXCEPTION 'No days selected.' USING ERRCODE = '22023';
    END IF;
    -- Bound the payload so a scripted caller can't stuff the table.
    IF array_length(p_dates, 1) > 60 THEN
        RAISE EXCEPTION 'Too many days in one request.' USING ERRCODE = '22023';
    END IF;

    v_staff_id := staff_id_for_pin(p_staff_id, p_pin);
    IF v_staff_id IS NULL THEN
        RETURN NULL;   -- caller renders the same "invalid PIN" path as the clock-in
    END IF;

    -- Postgres dow: 0=Sun … 6=Sat. The app's weekday index is 0=Mon … 4=Fri.
    IF p_recurring THEN
        v_weekday := ((EXTRACT(DOW FROM p_dates[1])::int + 6) % 7)::smallint;
    END IF;

    INSERT INTO staff_time_off_requests
        (staff_id, off_dates, recurring, weekday, reason, note, status, source)
    VALUES
        (v_staff_id, p_dates, COALESCE(p_recurring, false), v_weekday,
         left(COALESCE(p_reason, ''), 60), left(COALESCE(p_note, ''), 300),
         'pending', 'kiosk')
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('id', v_id, 'status', 'pending');
END;
$$;

REVOKE ALL ON FUNCTION public.list_my_time_off_requests(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_my_time_off_requests(uuid, integer) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.submit_time_off_request(uuid, integer, date[], boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_time_off_request(uuid, integer, date[], boolean, text, text) TO anon, authenticated;

-- ============================================================
-- VERIFY (run after applying, in the SQL editor)
-- ============================================================
-- 1. log_admin_action denies a non-admin:
--      -- as a non-admin authenticated session (or SET LOCAL ROLE authenticated
--      -- with a JWT whose email is not in settings.admin_roles):
--      SELECT log_admin_action('probe', 'test', 'x', '{}'::jsonb);
--      SELECT count(*) FROM admin_audit_log WHERE entity_id = 'x';  -- expect 0
--
-- 2. Old bare-PIN signatures are gone:
--      SELECT public.list_my_time_off_requests(1234);              -- expect: function does not exist
--      SELECT public.submit_time_off_request(1234, ARRAY[CURRENT_DATE]::date[]);  -- expect: function does not exist
--
-- 3. New signatures require a real (staff_id, pin) pair, same as staff_my_schedule:
--      SELECT public.list_my_time_off_requests('<a real active staff uuid>', <that staff's real PIN>);
--      -- expect: that staff's own requests (or [] if none)
--      SELECT public.list_my_time_off_requests('<that same uuid>', <a WRONG pin>);
--      -- expect: NULL, and staff.pin_failed_attempts for that id increments
-- ============================================================
