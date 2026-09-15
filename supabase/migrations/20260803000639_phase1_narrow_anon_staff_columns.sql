-- ============================================================
-- Phase 1 (R1 remediation) — narrow anon's column access to `staff`.
-- APPLIED IN PRODUCTION 2026-08-03.
--
-- anon held table-level SELECT on staff, which exposed through the public
-- API key: staff_pin_hash (same offline-brute-force exposure as families'
-- pin_hash, closed for families in r2_r3_revoke_anon_pin_access), plus
-- hourly_rate, salary_biweekly and pto_starting_balance — i.e. staff wages.
--
-- Verified before applying that no anon-reachable code path reads this table:
--   * none of the 11 anon-reachable HTML pages contain from('staff')
--   * none of the 9 non-admin JS entry points contain from('staff')
--   * clockin.html (the kiosk) resolves staff via the lookup_staff_by_pin
--     RPC, which is SECURITY DEFINER and needs no table grant at all
--   * the kiosk's three staff_clock_events queries embed no staff(...) join
--   * fetchAllStaff() is called only from admin-reports / admin-staffing /
--     admin-finance, which run as `authenticated` and are untouched here
--   * pg_stat_statements (complete since 2026-03-10, dealloc=0) records zero
--     PostgREST queries reading staff_pin_hash and zero `select *` on staff
--
-- Display columns are still granted rather than revoking SELECT outright, so
-- that any read path missed by the above degrades to "no wage data" instead
-- of erroring. `authenticated` keeps full table access via its own grant.
--
-- staff_pin (legacy plaintext) is excluded too; verified empty on all 34 rows.
--
-- Post-apply smoke tests (both passed):
--   set local role anon;          select lookup_staff_by_pin(99999);  -- no permission error
--   set local role authenticated; select <fetchAllStaff column list> from staff; -- 34 rows
-- ============================================================
REVOKE SELECT ON public.staff FROM anon;

GRANT SELECT (
    id,
    name,
    email,
    role,
    room_id,
    active,
    hire_date,
    created_at,
    has_staff_pin
) ON public.staff TO anon;
