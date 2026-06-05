-- ============================================================
-- S1 (Tier 1) — Remove vestigial, over-permissive anon/public RLS policies
-- ============================================================
-- VERIFIED 2026-06-05 against the codebase: no non-admin JS file and no public
-- HTML reads or writes families / students / staff directly. The parent flows use
-- service-role edge functions (family-lookup, request-pin-reset) and SECURITY
-- DEFINER RPCs (family_login, lookup_staff_by_pin) that BYPASS RLS, and every
-- families/students/staff helper in supabase.js is called only from js/admin/*
-- (which runs as `authenticated`). The policies below are leftovers from an older
-- architecture and currently let the public anon key:
--   • SELECT families/students  → dump every parent email/phone + child name/DOB
--   • UPDATE families/students   → tamper with any record (e.g. flip login_locked)
--   • DELETE students            → destroy any child record
--   • SELECT staff (public/anon) → read hourly_rate / salary_biweekly for all staff
--
-- Dropping policies only REMOVES access; it cannot expose anything new. Admin
-- access is unaffected (covered by the authenticated admin_all / auth policies).
--
-- ⚠️ TEST IN STAGING after applying — exercise:
--     1) a full parent registration (submit) and the calendar spots-left display,
--     2) the clock-in kiosk (PIN lookup via lookup_staff_by_pin),
--     3) an admin login → Families, Staff, and Classrooms tabs.
--   All should still work; only direct anon access to these tables is removed.
--
-- NOTE: anon INSERT policies on families/students are intentionally LEFT in place
-- (lower risk; usage by the onboarding flow not fully traced). Review separately.
-- NOTE: registrations / registration_dates anon SELECT remain USING(true) — those
-- are load-bearing (public dup-check + capacity counts). See Tier 2: move those
-- reads into SECURITY DEFINER RPCs, then drop the anon SELECT.
-- ============================================================

DROP POLICY IF EXISTS "anon select families"      ON families;
DROP POLICY IF EXISTS "anon update families"      ON families;

DROP POLICY IF EXISTS "anon select students"      ON students;
DROP POLICY IF EXISTS "anon update students"      ON students;
DROP POLICY IF EXISTS "anon delete students"      ON students;

DROP POLICY IF EXISTS "Anon PIN lookup"           ON staff;
DROP POLICY IF EXISTS "anon read active staff"    ON staff;

-- Verify afterwards (no anon SELECT/UPDATE/DELETE should remain on these tables):
-- SELECT tablename, policyname, cmd, roles, qual
-- FROM pg_policies
-- WHERE tablename IN ('families','students','staff') ORDER BY tablename, cmd;
