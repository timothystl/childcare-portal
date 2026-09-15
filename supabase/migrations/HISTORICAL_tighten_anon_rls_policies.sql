-- ============================================================
-- ⛔ DO NOT APPLY — THIS MIGRATION CAUSED A PRODUCTION REGRESSION (2026-06-05)
-- ============================================================
--
-- ⚠️ CORRECTION 2026-08-11 — THE ROOT-CAUSE NOTE BELOW IS WRONG.
--   `family_login` is SECURITY DEFINER: declared so in add_family_login_rpc.sql
--   (its original migration) and confirmed in production
--   (pg_proc.prosecdef = true). A definer function executes with its owner's
--   privileges and bypasses RLS, so dropping an anon policy on `families`
--   CANNOT starve its internal lookup. `lookup_staff_by_pin` is likewise
--   SECURITY DEFINER.
--
--   Corroborating evidence: the R3 fix later revoked anon's SELECT on
--   families.pin_hash and parent login kept working.
--
--   So the true cause of the 2026-06-05 regression is UNKNOWN. Note that this
--   file drops SEVEN policies across THREE tables at once — including three
--   `staff` SELECT policies, and ~1,600 anon calls per five months hit `staff`.
--   The kiosk is the more likely casualty than login.
--
--   DO NOT treat "family_login needs anon SELECT on families" as fact. The
--   evidence-based replacement for the families/students half of this file is
--   r1r4_phase1_families_students.sql (+ its ROLLBACK). The `staff` half
--   remains untriaged.
--
-- ── original (incorrect) note, kept for the record ───────────
-- Dropping the anon SELECT on `families` broke PARENT LOGIN: the family_login
-- RPC is evidently SECURITY INVOKER (runs as the anon caller), so without an
-- anon SELECT policy on families its internal lookup returns 0 rows →
-- "No family found matching that email and PIN." The earlier claim that the
-- parent/kiosk RPCs are SECURITY DEFINER (and bypass RLS) was NOT verified —
-- those functions live in the dashboard, not in this repo.
--
-- ROLLBACK: run ROLLBACK_tighten_anon_rls_policies.sql.
--
-- CORRECT FIX (instead of this file): make family_login (and lookup_staff_by_pin)
-- SECURITY DEFINER so they bypass RLS, THEN these anon policies can be dropped
-- safely. That requires the real function definitions — see docs/NEXT_STEPS.md.
-- The original (no-longer-recommended) statements are kept below for reference.
-- ============================================================

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
