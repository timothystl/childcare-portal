-- ROLLBACK — policy_scoping_stage2_admin_only_tables.sql
-- Restores blanket authenticated access. Only do this if the admin app is
-- broken AND stage 1's predicate is proven to be the cause.
--
-- Deliberately does NOT restore the two "ALL TO public" policies on staff and
-- staff_hours. Those let the public anon key write payroll hours; they were a
-- defect, not a feature, and nothing reads through them.

DROP POLICY IF EXISTS "admin full only"      ON public.staff;
CREATE POLICY "auth full access staff" ON public.staff FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "admin full only"      ON public.staff_hours;
CREATE POLICY "auth full access hours" ON public.staff_hours FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "admin full only"      ON public.billing_cycles;
CREATE POLICY "Auth access" ON public.billing_cycles FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "admin full only"      ON public.billing_invoices;
CREATE POLICY "Auth access" ON public.billing_invoices FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "admin full only"      ON public.billing_payments;
CREATE POLICY "Auth access" ON public.billing_payments FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "admin full only"      ON public.billing_import_batches;
CREATE POLICY "Auth access" ON public.billing_import_batches FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "admin full only"      ON public.billing_overrides;
CREATE POLICY "Admin full access to billing_overrides" ON public.billing_overrides FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "admin full only"      ON public.family_rates;
CREATE POLICY "Auth access" ON public.family_rates FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "admin full only"      ON public.market_providers;
CREATE POLICY "admin_all_market_providers" ON public.market_providers FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "admin full only"      ON public.cacfp_income_applications;
CREATE POLICY "admin_all_cacfp_income_applications" ON public.cacfp_income_applications FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "admin full only"      ON public.cacfp_claim_lines;
CREATE POLICY "admin_all_cacfp_claim_lines" ON public.cacfp_claim_lines FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "admin full only"      ON public.cacfp_claim_periods;
CREATE POLICY "admin_all_cacfp_claim_periods" ON public.cacfp_claim_periods FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "admin full only"      ON public.cacfp_reimbursement_rates;
CREATE POLICY "admin_all_cacfp_reimbursement_rates" ON public.cacfp_reimbursement_rates FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "admin full only read" ON public.admin_audit_log;
CREATE POLICY "auth read audit log" ON public.admin_audit_log FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "admin any role"       ON public.staff_clock_events;
CREATE POLICY "auth full access clock" ON public.staff_clock_events FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "admin any role"       ON public.staff_time_off_requests;
CREATE POLICY "authenticated manage time off" ON public.staff_time_off_requests FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "admin any role"       ON public.attendance_records;
CREATE POLICY "admin_all_attendance_records" ON public.attendance_records FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "admin any role"       ON public.deletion_requests;
CREATE POLICY "authenticated admin read and update" ON public.deletion_requests FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "admin any role"       ON public.cacfp_meal_records;
CREATE POLICY "admin_all_cacfp_meal_records" ON public.cacfp_meal_records FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "admin any role"       ON public.cacfp_menus;
CREATE POLICY "admin_all_cacfp_menus" ON public.cacfp_menus FOR ALL TO authenticated USING (true) WITH CHECK (true);
