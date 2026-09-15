-- ============================================================
-- STAFF TIME-OFF REQUESTS  (admin portal redesign)
-- ============================================================
-- Joins the Staff Kiosk to the Director dashboard:
--   staff request a day off at the time clock  →  the request lands
--   *pending* in the director's "Needs your OK" panel  →  she approves
--   or declines  →  only approved days off are respected by the
--   schedule builder.
--
-- She can also key in days off staff told her verbally; those are
-- inserted directly as source='director' / status='approved' since
-- she has already vetted them.
--
-- SECURITY MODEL (mirrors lookup_staff_by_pin / hash_staff_pins.sql):
--   * anon gets ZERO table grants. The kiosk reaches the table only
--     through the two SECURITY DEFINER RPCs below, both of which
--     re-verify the staff PIN with bcrypt before touching a row.
--   * `authenticated` (the admin portal) gets full CRUD via RLS.
--   * search_path is pinned on every definer function (SS10).
--
-- Apply by hand in the Supabase SQL Editor — supabase/migrations/ is
-- NOT auto-applied. Verify with the checks at the bottom of the file.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 1. Table ─────────────────────────────────────────────────
-- staff.id is uuid (gen_random_uuid), as is staff_id on staff_clock_events,
-- staff_hours and staff_schedules — staff_id here must match. The request's
-- own PK is bigserial, following staff_schedules.
CREATE TABLE IF NOT EXISTS public.staff_time_off_requests (
    id           bigserial PRIMARY KEY,
    staff_id     uuid        NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
    -- Explicit calendar dates the staffer asked off. For a standing
    -- request this is still populated (the first occurrence) so the
    -- director sees a concrete date; `recurring` + `weekday` carry the
    -- "every week from now on" meaning.
    off_dates    date[]      NOT NULL,
    recurring    boolean     NOT NULL DEFAULT false,
    -- 0=Mon … 4=Fri. Only meaningful when recurring = true. Constrained to
    -- weekdays: the center is closed at weekends, the kiosk calendar offers
    -- Mon–Fri only, and the admin UI indexes a five-entry day array.
    weekday      smallint,
    reason       text        NOT NULL DEFAULT '',
    note         text        NOT NULL DEFAULT '',
    status       text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'approved', 'declined')),
    source       text        NOT NULL DEFAULT 'kiosk'
                             CHECK (source IN ('kiosk', 'director')),
    submitted_at timestamptz NOT NULL DEFAULT now(),
    decided_at   timestamptz,
    decided_by   text,
    CONSTRAINT staff_time_off_dates_not_empty CHECK (array_length(off_dates, 1) >= 1),
    CONSTRAINT staff_time_off_weekday_range   CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 4)
);

-- The director's queue reads pending-first, newest-first; the schedule
-- builder reads approved rows overlapping one week.
CREATE INDEX IF NOT EXISTS staff_time_off_status_idx
    ON public.staff_time_off_requests (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS staff_time_off_staff_idx
    ON public.staff_time_off_requests (staff_id, submitted_at DESC);

-- ── 2. RLS ───────────────────────────────────────────────────
ALTER TABLE public.staff_time_off_requests ENABLE ROW LEVEL SECURITY;

-- Belt and braces: Supabase hands `anon` default grants on new tables in
-- some project configurations (this is exactly how R5's audit log became
-- anon-readable). Revoke explicitly rather than trusting the default.
REVOKE ALL ON public.staff_time_off_requests FROM anon, PUBLIC;
REVOKE ALL ON SEQUENCE public.staff_time_off_requests_id_seq FROM anon, PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_time_off_requests TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.staff_time_off_requests_id_seq TO authenticated;

DROP POLICY IF EXISTS "authenticated manage time off" ON public.staff_time_off_requests;
CREATE POLICY "authenticated manage time off"
    ON public.staff_time_off_requests
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- ── 3. Kiosk RPC: submit a request ───────────────────────────
-- Anon-executable but PIN-gated: the caller must present a PIN that
-- bcrypt-matches an active staff row, and the request is filed against
-- THAT staff id — a caller cannot file on someone else's behalf.
CREATE OR REPLACE FUNCTION public.submit_time_off_request(
    p_pin       int,
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

    SELECT s.id INTO v_staff_id
    FROM staff s
    WHERE s.active = true
      AND s.staff_pin_hash IS NOT NULL
      AND crypt(p_pin::text, s.staff_pin_hash) = s.staff_pin_hash
    LIMIT 1;

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

REVOKE ALL ON FUNCTION public.submit_time_off_request(int, date[], boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_time_off_request(int, date[], boolean, text, text) TO anon, authenticated;

-- ── 4. Kiosk RPC: read back my own requests ──────────────────
-- Returns only the PIN-holder's rows, and only the columns the kiosk
-- renders — never another staffer's time off.
CREATE OR REPLACE FUNCTION public.list_my_time_off_requests(p_pin int)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_staff_id uuid;
    v_rows     jsonb;
BEGIN
    SELECT s.id INTO v_staff_id
    FROM staff s
    WHERE s.active = true
      AND s.staff_pin_hash IS NOT NULL
      AND crypt(p_pin::text, s.staff_pin_hash) = s.staff_pin_hash
    LIMIT 1;

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

REVOKE ALL ON FUNCTION public.list_my_time_off_requests(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_my_time_off_requests(int) TO anon, authenticated;

-- ============================================================
-- VERIFY (run after applying)
-- ============================================================
-- 1. anon holds no grants on the table:
--      SELECT grantee, privilege_type FROM information_schema.role_table_grants
--       WHERE table_name = 'staff_time_off_requests';
--    → expect `authenticated` rows only.
--
-- 2. anon read is denied (run in the SQL editor with role anon):
--      SET LOCAL ROLE anon;
--      SELECT * FROM staff_time_off_requests;     -- expect: permission denied
--      RESET ROLE;
--
-- 3. The kiosk path still works as anon:
--      SET LOCAL ROLE anon;
--      SELECT public.submit_time_off_request(<a real test PIN>,
--             ARRAY[CURRENT_DATE + 7]::date[], false, 'Appointment', 'test');
--      RESET ROLE;
--    → expect a jsonb {id, status:"pending"}; then delete the test row.
-- ============================================================
