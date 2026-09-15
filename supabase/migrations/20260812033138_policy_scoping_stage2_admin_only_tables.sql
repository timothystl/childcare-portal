-- ============================================================
-- POLICY SCOPING — STAGE 2: admin-only tables
-- ============================================================
-- Plan: docs/POLICY_SCOPING_PLAN.md. Depends on stage 1 (is_admin/admin_role).
-- APPLIED AND VERIFIED IN PRODUCTION 2026-08-11.
--
-- Scopes wages, payroll, money, audit, market and CACFP to real admins instead
-- of "anyone holding an authenticated token". Money and pay require
-- admin_role() = 'full', which makes the role tiers real rather than a
-- browser-side convention — that is R20.
--
-- Safe to apply now because all three remaining admins are 'full'
-- (dinger@, mdo@, bookkeeper@); the one 'restricted' admin was removed from
-- both admin_roles and auth.users when she left.
--
-- ── TWO LIVE EXPOSURES FOUND WHILE SCOPING THIS ──
--
-- 1. `staff` and `staff_hours` each carried a redundant `ALL TO public
--    USING (true)` policy alongside the authenticated one. RLS policies are
--    OR'd, so those made every other policy on the table irrelevant — scoping
--    the authenticated policy alone would have achieved nothing. Because
--    `public` includes `anon`, and anon holds INSERT/UPDATE/DELETE grants on
--    staff_hours, the public key could modify or delete payroll hours (151
--    rows, 33 staff). Both dropped here.
--
--    The anon SELECT policies are deliberately left in place: pg_stat_statements
--    shows 68 real anon reads of staff_hours and 62 of staff, so something in
--    the kiosk depends on them. Removing read access needs its own change.
--
-- 2. ⚠️ STILL OPEN — `anon` holds column-level SELECT on `staff.hourly_rate`
--    and `staff.salary_biweekly`. CLAUDE.md records R26 as having narrowed anon
--    to display columns and verified; the wage columns are still granted, so
--    R26 is incomplete or was partially reverted. Not fixed here because the
--    anon read path must be identified first. Track and close.
--
-- ROLLBACK: ROLLBACK_policy_scoping_stage2_admin_only_tables.sql
-- ============================================================

DROP POLICY IF EXISTS "Auth staff"       ON public.staff;
DROP POLICY IF EXISTS "Auth staff_hours" ON public.staff_hours;

-- Tier 1 — full admins only
DROP POLICY IF EXISTS "auth full access staff" ON public.staff;
CREATE POLICY "admin full only" ON public.staff FOR ALL TO authenticated
    USING (admin_role() = 'full') WITH CHECK (admin_role() = 'full');

DROP POLICY IF EXISTS "auth full access hours" ON public.staff_hours;
CREATE POLICY "admin full only" ON public.staff_hours FOR ALL TO authenticated
    USING (admin_role() = 'full') WITH CHECK (admin_role() = 'full');

DROP POLICY IF EXISTS "Auth access" ON public.billing_cycles;
CREATE POLICY "admin full only" ON public.billing_cycles FOR ALL TO authenticated
    USING (admin_role() = 'full') WITH CHECK (admin_role() = 'full');

DROP POLICY IF EXISTS "Auth access" ON public.billing_invoices;
CREATE POLICY "admin full only" ON public.billing_invoices FOR ALL TO authenticated
    USING (admin_role() = 'full') WITH CHECK (admin_role() = 'full');

DROP POLICY IF EXISTS "Auth access" ON public.billing_payments;
CREATE POLICY "admin full only" ON public.billing_payments FOR ALL TO authenticated
    USING (admin_role() = 'full') WITH CHECK (admin_role() = 'full');

DROP POLICY IF EXISTS "Auth access" ON public.billing_import_batches;
CREATE POLICY "admin full only" ON public.billing_import_batches FOR ALL TO authenticated
    USING (admin_role() = 'full') WITH CHECK (admin_role() = 'full');

DROP POLICY IF EXISTS "Admin full access to billing_overrides" ON public.billing_overrides;
CREATE POLICY "admin full only" ON public.billing_overrides FOR ALL TO authenticated
    USING (admin_role() = 'full') WITH CHECK (admin_role() = 'full');

DROP POLICY IF EXISTS "Auth access" ON public.family_rates;
CREATE POLICY "admin full only" ON public.family_rates FOR ALL TO authenticated
    USING (admin_role() = 'full') WITH CHECK (admin_role() = 'full');

DROP POLICY IF EXISTS "admin_all_market_providers" ON public.market_providers;
CREATE POLICY "admin full only" ON public.market_providers FOR ALL TO authenticated
    USING (admin_role() = 'full') WITH CHECK (admin_role() = 'full');

DROP POLICY IF EXISTS "admin_all_cacfp_income_applications" ON public.cacfp_income_applications;
CREATE POLICY "admin full only" ON public.cacfp_income_applications FOR ALL TO authenticated
    USING (admin_role() = 'full') WITH CHECK (admin_role() = 'full');

DROP POLICY IF EXISTS "admin_all_cacfp_claim_lines" ON public.cacfp_claim_lines;
CREATE POLICY "admin full only" ON public.cacfp_claim_lines FOR ALL TO authenticated
    USING (admin_role() = 'full') WITH CHECK (admin_role() = 'full');

DROP POLICY IF EXISTS "admin_all_cacfp_claim_periods" ON public.cacfp_claim_periods;
CREATE POLICY "admin full only" ON public.cacfp_claim_periods FOR ALL TO authenticated
    USING (admin_role() = 'full') WITH CHECK (admin_role() = 'full');

DROP POLICY IF EXISTS "admin_all_cacfp_reimbursement_rates" ON public.cacfp_reimbursement_rates;
CREATE POLICY "admin full only" ON public.cacfp_reimbursement_rates FOR ALL TO authenticated
    USING (admin_role() = 'full') WITH CHECK (admin_role() = 'full');

-- Read-only from the client: entries are written by a definer RPC, and an
-- admin must not be able to edit or delete the record of their own actions.
DROP POLICY IF EXISTS "auth read audit log" ON public.admin_audit_log;
CREATE POLICY "admin full only read" ON public.admin_audit_log FOR SELECT TO authenticated
    USING (admin_role() = 'full');

-- Tier 2 — any admin role
DROP POLICY IF EXISTS "auth full access clock" ON public.staff_clock_events;
CREATE POLICY "admin any role" ON public.staff_clock_events FOR ALL TO authenticated
    USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "authenticated manage time off" ON public.staff_time_off_requests;
CREATE POLICY "admin any role" ON public.staff_time_off_requests FOR ALL TO authenticated
    USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "admin_all_attendance_records" ON public.attendance_records;
CREATE POLICY "admin any role" ON public.attendance_records FOR ALL TO authenticated
    USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "authenticated admin read and update" ON public.deletion_requests;
CREATE POLICY "admin any role" ON public.deletion_requests FOR ALL TO authenticated
    USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "admin_all_cacfp_meal_records" ON public.cacfp_meal_records;
CREATE POLICY "admin any role" ON public.cacfp_meal_records FOR ALL TO authenticated
    USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "admin_all_cacfp_menus" ON public.cacfp_menus;
CREATE POLICY "admin any role" ON public.cacfp_menus FOR ALL TO authenticated
    USING (is_admin()) WITH CHECK (is_admin());

-- ── Verification (all passed post-apply) ─────────────────────
--   * full admin still resolves admin_role() = 'full'
--   * a stranger with a valid authenticated token: is_admin() false, role NULL
--   * zero ALL-to-public policies remain on staff / staff_hours
--   * tables still open to any authenticated identity: 27 -> 7, and those 7
--     (closures, families, messages, registration_dates, registrations,
--     settings, students) are exactly the deferred stages 3-5 / Phase 1 set.
