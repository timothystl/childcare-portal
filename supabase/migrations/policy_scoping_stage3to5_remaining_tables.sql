-- ============================================================
-- POLICY SCOPING — STAGES 3, 4 and 5
-- ============================================================
-- APPLIED AND VERIFIED IN PRODUCTION 2026-08-11. Completes the work begun in
-- stages 1 and 2. Tables policied open to any authenticated identity: 7 -> 0.
--
-- ── STAGE 3: settings, scoped by key ──
-- A THIRD LIVE EXPOSURE, found here. settings carried "Public read" TO public
-- USING (true) alongside an anon SELECT grant, so EVERY key was readable with
-- the public anon key that ships in every browser:
--   admin_roles (the admin email roster), historical_payroll (7.6KB of payroll
--   history), staff_directory, staff_availability, annual_budget_2026,
--   expense_config, market_analysis_context, pto settings.
--
-- Public pages need a small allow-list, established by tracing actual reads in
-- js/app.js, js/supabase.js and clockin.html. staff_directory IS public — it
-- renders the "Our Staff" section on the registration page. geofence is needed
-- by the clock-in kiosk.
--
-- is_admin() reads this table. As a postgres-owned SECURITY DEFINER function it
-- bypasses this policy rather than recursing into it — that is exactly why
-- stage 1 insisted on definer rights.
--
-- ── STAGE 4: closures ── admin write scoped; public calendar keeps anon read.
--
-- ── STAGE 5: the tables the parent portal will share ──
-- Admin side scoped now; parent_portal policies are written in Phase 1 against
-- the same tables so both sides are designed together. Existing anon policies
-- are deliberately untouched: registrations/registration_dates anon SELECT is
-- load-bearing for capacity counts and the duplicate check (R1 remainder), and
-- the anon INSERTs are the public registration flow itself.
--
-- Two dead policies removed for honesty: "anon insert closures" and
-- "anon select messages" both grant nothing (the underlying grants were
-- revoked by phase1_revoke_unused_anon_verbs / R27) and made the policy list
-- misrepresent reality.
--
-- ROLLBACK: ROLLBACK_policy_scoping_stage3to5_remaining_tables.sql
-- ============================================================

-- STAGE 3
DROP POLICY IF EXISTS "Public read"          ON public.settings;
DROP POLICY IF EXISTS "anon select settings" ON public.settings;
DROP POLICY IF EXISTS "Auth write"           ON public.settings;
DROP POLICY IF EXISTS "admin_all_settings"   ON public.settings;
DROP POLICY IF EXISTS "auth all settings"    ON public.settings;
DROP POLICY IF EXISTS "anon insert settings" ON public.settings;

CREATE POLICY "public read allowed keys" ON public.settings
    FOR SELECT TO anon
    USING (key = ANY (ARRAY[
        'room_rates', 'room_capacity', 'staff_ratios',
        'reg_window_override', 'registration_fee', 'registration_fee_renewal_date',
        'new_family_fee', 'supply_fee_family_max',
        'hide_summer_camp', 'enrollment_at_capacity',
        'offer_links', 'geofence', 'staff_directory'
    ]));

CREATE POLICY "admin all settings" ON public.settings
    FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- STAGE 4
DROP POLICY IF EXISTS "admin_all_closures"   ON public.closures;
CREATE POLICY "admin any role" ON public.closures FOR ALL TO authenticated
    USING (is_admin()) WITH CHECK (is_admin());
DROP POLICY IF EXISTS "anon insert closures" ON public.closures;

-- STAGE 5
DROP POLICY IF EXISTS "admin_all_families"           ON public.families;
CREATE POLICY "admin any role" ON public.families FOR ALL TO authenticated
    USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "admin_all_students"           ON public.students;
CREATE POLICY "admin any role" ON public.students FOR ALL TO authenticated
    USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "admin_all_registrations"      ON public.registrations;
CREATE POLICY "admin any role" ON public.registrations FOR ALL TO authenticated
    USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "admin_all_registration_dates" ON public.registration_dates;
CREATE POLICY "admin any role" ON public.registration_dates FOR ALL TO authenticated
    USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "admin_all_messages"           ON public.messages;
CREATE POLICY "admin any role" ON public.messages FOR ALL TO authenticated
    USING (is_admin()) WITH CHECK (is_admin());
DROP POLICY IF EXISTS "anon select messages" ON public.messages;

-- ── Verification (all passed post-apply) ─────────────────────
--   anon sees only allow-listed settings keys; admin_roles,
--     historical_payroll, staff_availability, annual_budget_2026,
--     expense_config, market_analysis_context, pto_accrual_rate and
--     waitlist_notify are all denied to anon.
--   admin still reads all 22 settings keys — no recursion.
--   admin reads settings, closures, families, students, registrations,
--     registration_dates, messages, staff, staff_hours, billing_invoices,
--     attendance_records, admin_audit_log.
--   anon still reads registrations, registration_dates, closures, settings.
--   Tables open to any authenticated identity: 0.
