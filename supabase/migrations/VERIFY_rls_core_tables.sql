-- ============================================================
-- S1 — VERIFY (and, if needed, enable) RLS on the core PII tables
-- ============================================================
-- These four tables have NO RLS statements anywhere in supabase/migrations/.
-- They were created directly in the Supabase dashboard, so their RLS status
-- cannot be confirmed from this repo and MUST be checked in the live project.
--
-- ⚠️  DO NOT blindly run the policy section below. The PUBLIC registration flow
--     uses the anon key directly, so these tables have real anon access needs:
--       • registrations / registration_dates — anon INSERT (submitRegistration)
--         and anon SELECT (capacity counting via fetchCapacityForDates).
--       • families / students — primarily read through the family_login RPC
--         (SECURITY DEFINER, which bypasses RLS) and written by admins; verify
--         whether the public app ever reads/writes them directly before locking.
--     Enabling RLS without matching policies WILL break registration and the
--     calendar's spots-left display. Treat the policies below as a starting
--     point to review against the live access patterns, not a drop-in.
-- ============================================================

-- ---- STEP 1: VERIFY (read-only — safe to run now) ----
-- relrowsecurity = true means RLS is ON. Check all four.
SELECT relname AS table_name, relrowsecurity AS rls_enabled
FROM pg_class
WHERE relname IN ('families', 'students', 'registrations', 'registration_dates', 'staff')
ORDER BY relname;

-- List any existing policies on these tables.
SELECT schemaname, tablename, policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE tablename IN ('families', 'students', 'registrations', 'registration_dates', 'staff')
ORDER BY tablename, policyname;


-- ---- STEP 2: DRAFT POLICIES (review before enabling — commented out) ----
-- Uncomment and ADAPT per the verification results above. Test in staging:
-- run a full parent registration + a calendar load + an admin family view.
--
-- -- registrations: anon may insert (public submit) and read (capacity counts);
-- -- admins (authenticated) get full access.
-- ALTER TABLE registrations ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "anon insert registrations"  ON registrations FOR INSERT TO anon WITH CHECK (true);
-- CREATE POLICY "anon select registrations"  ON registrations FOR SELECT TO anon USING (true);
-- CREATE POLICY "auth all registrations"     ON registrations FOR ALL    TO authenticated USING (true) WITH CHECK (true);
-- -- NOTE: "anon select true" still exposes parent_email/child_name to the anon
-- -- key. If you only need capacity counts publicly, prefer a SECURITY DEFINER
-- -- RPC that returns counts and a SELECT policy restricted to authenticated.
--
-- -- registration_dates: same shape (insert on submit, select for capacity).
-- ALTER TABLE registration_dates ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "anon insert reg_dates" ON registration_dates FOR INSERT TO anon WITH CHECK (true);
-- CREATE POLICY "anon select reg_dates" ON registration_dates FOR SELECT TO anon USING (true);
-- CREATE POLICY "auth all reg_dates"    ON registration_dates FOR ALL    TO authenticated USING (true) WITH CHECK (true);
--
-- -- families / students: prefer NO anon access — reads go through family_login
-- -- (definer) and writes through admins. Verify the public app doesn't touch
-- -- them directly first.
-- ALTER TABLE families ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "auth all families" ON families FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- ALTER TABLE students ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "auth all students" ON students FOR ALL TO authenticated USING (true) WITH CHECK (true);
--
-- -- staff: admin-only; the kiosk reads via lookup_staff_by_pin (definer).
-- ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "auth all staff" ON staff FOR ALL TO authenticated USING (true) WITH CHECK (true);
