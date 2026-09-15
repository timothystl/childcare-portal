-- ============================================================
-- Restricted admins can see the staff roster, with pay redacted
-- ============================================================
-- Asked for directly: the `restricted` admin role should be able to see the
-- Staff tab (names, rooms, roles — what she needs to build the weekly
-- schedule) without seeing wages or payroll figures.
--
-- The `staff` table's own RLS ("admin full only" in
-- policy_scoping_stage2_admin_only_tables.sql) is a single FOR ALL policy
-- gated on admin_role() = 'full'. RLS is row-level, not column-level, and
-- both admin tiers connect as the same `authenticated` Postgres role — so
-- there is no way to grant `restricted` SELECT on `staff` and have Postgres
-- itself hide hourly_rate/salary_biweekly/pto_starting_balance from that
-- same query. Widening the table's own SELECT policy would hand a
-- restricted admin those columns the moment they asked for them directly,
-- CLAUDE.md's own R20 lesson (browser-only redaction is not redaction).
--
-- So the table's RLS is UNCHANGED — writes and raw full-column reads stay
-- `full`-only. This adds one SECURITY DEFINER RPC that any admin can call,
-- returning the roster with the pay columns nulled out for anyone who is
-- not `admin_role() = 'full'`. The redaction happens in the database,
-- before the response ever reaches the browser — not a UI hide.
--
-- This is also what fixes staff names not populating in Build Staff
-- Schedule / the "Needs your OK" time-off queue for a restricted admin:
-- both used a PostgREST embedded join (`staff:staff_id(name)`) against the
-- `staff` table, which the full-only RLS silently blocked (an embed just
-- returns null for a row the caller can't see — no error, no name). The
-- accompanying JS change stops relying on that embed and resolves names
-- through this RPC instead.
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_staff_roster()
RETURNS TABLE (
    id                   uuid,
    name                 text,
    email                text,
    phone                text,
    role                 text,
    room_id              text,
    active               boolean,
    hire_date            date,
    has_staff_pin        boolean,
    created_at           timestamptz,
    profile_photo_path   text,
    pay_type             text,
    hourly_rate          numeric,
    salary_biweekly      numeric,
    pto_starting_balance numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        s.id, s.name, s.email, s.phone, s.role, s.room_id, s.active,
        s.hire_date, s.has_staff_pin, s.created_at, s.profile_photo_path,
        CASE WHEN public.admin_role() = 'full' THEN s.pay_type             END,
        CASE WHEN public.admin_role() = 'full' THEN s.hourly_rate          END,
        CASE WHEN public.admin_role() = 'full' THEN s.salary_biweekly      END,
        CASE WHEN public.admin_role() = 'full' THEN s.pto_starting_balance END
    FROM public.staff s
    WHERE public.is_admin()
    ORDER BY s.name;
$$;

GRANT EXECUTE ON FUNCTION public.admin_staff_roster() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_staff_roster() FROM PUBLIC, anon;

-- ── Verification ─────────────────────────────────────────────
-- sonya.tgcs@gmail.com is the CURRENT restricted admin (checked live against
-- settings.admin_roles before writing this — amy.b.ricketts@gmail.com, the
-- stage-1 migration's own test fixture, was removed when she left; using it
-- here failed with 0 rows on the first attempt to apply this migration).
DO $$
DECLARE
    v_full_rows   int;
    v_restr_rows  int;
    v_full_pay    int;
    v_restr_pay   int;
    v_stranger    int;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"email":"mdo@timothystl.org"}', true);
    SELECT count(*), count(*) FILTER (WHERE hourly_rate IS NOT NULL OR salary_biweekly IS NOT NULL)
      INTO v_full_rows, v_full_pay
      FROM public.admin_staff_roster();
    IF v_full_rows = 0 THEN RAISE EXCEPTION 'FAILED: full admin got zero staff rows'; END IF;
    IF v_full_pay = 0 THEN RAISE EXCEPTION 'FAILED: full admin got no pay data at all'; END IF;

    PERFORM set_config('request.jwt.claims', '{"email":"sonya.tgcs@gmail.com"}', true);
    SELECT count(*), count(*) FILTER (WHERE hourly_rate IS NOT NULL OR salary_biweekly IS NOT NULL OR pto_starting_balance IS NOT NULL OR pay_type IS NOT NULL)
      INTO v_restr_rows, v_restr_pay
      FROM public.admin_staff_roster();
    IF v_restr_rows <> v_full_rows THEN
        RAISE EXCEPTION 'FAILED: restricted admin saw % rows, full saw %', v_restr_rows, v_full_rows;
    END IF;
    IF v_restr_pay <> 0 THEN
        RAISE EXCEPTION 'FAILED: restricted admin received % rows with pay data still attached', v_restr_pay;
    END IF;

    PERFORM set_config('request.jwt.claims', '{"email":"a.stranger@example.com"}', true);
    SELECT count(*) INTO v_stranger FROM public.admin_staff_roster();
    IF v_stranger <> 0 THEN RAISE EXCEPTION 'FAILED: a non-admin token got % staff rows', v_stranger; END IF;

    RAISE NOTICE 'admin_staff_roster: all cases passed (full rows=%, restricted rows=%)', v_full_rows, v_restr_rows;
END $$;
