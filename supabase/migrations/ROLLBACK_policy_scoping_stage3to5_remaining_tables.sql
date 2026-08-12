-- ROLLBACK — policy_scoping_stage3to5_remaining_tables.sql
--
-- ⚠️ The settings rollback re-exposes admin_roles, historical_payroll,
-- staff_directory, staff_availability, annual_budget_2026, expense_config and
-- market_analysis_context to the public anon key. Prefer widening the
-- allow-list in the forward migration over running this.

DROP POLICY IF EXISTS "public read allowed keys" ON public.settings;
DROP POLICY IF EXISTS "admin all settings"       ON public.settings;
CREATE POLICY "Public read"        ON public.settings FOR SELECT USING (true);
CREATE POLICY "admin_all_settings" ON public.settings FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "admin any role" ON public.closures;
CREATE POLICY "admin_all_closures" ON public.closures FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "admin any role" ON public.families;
CREATE POLICY "admin_all_families" ON public.families FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "admin any role" ON public.students;
CREATE POLICY "admin_all_students" ON public.students FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "admin any role" ON public.registrations;
CREATE POLICY "admin_all_registrations" ON public.registrations FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "admin any role" ON public.registration_dates;
CREATE POLICY "admin_all_registration_dates" ON public.registration_dates FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "admin any role" ON public.messages;
CREATE POLICY "admin_all_messages" ON public.messages FOR ALL TO authenticated USING (true) WITH CHECK (true);
