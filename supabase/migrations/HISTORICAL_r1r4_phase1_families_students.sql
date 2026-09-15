-- ============================================================
-- R1/R4 Phase 1 — remove anon read + destructive access to
--                 `families` and `students`
-- ============================================================
-- Closes the read exposure (R1) and the destructive verbs (R4) for the two
-- tables that hold the actual child and parent PII, WITHOUT touching anything
-- the public app demonstrably uses.
--
-- Not auto-applied. Run by hand in the Supabase SQL Editor (see CLAUDE.md).
-- ROLLBACK: ROLLBACK_r1r4_phase1_families_students.sql — one statement per
-- object, restores the exact prior definitions.
--
-- ------------------------------------------------------------
-- WHY THIS IS SAFE (evidence gathered 2026-08-11, not assumption)
-- ------------------------------------------------------------
-- 1. `family_login` is SECURITY DEFINER (pg_proc.prosecdef = true, and declared
--    so in add_family_login_rpc.sql). It runs as its owner and bypasses RLS, so
--    dropping an anon policy on `families` cannot affect parent login.
--
--    NOTE: this contradicts the ⛔ header on tighten_anon_rls_policies.sql,
--    which blamed the 2026-06-05 login regression on family_login being
--    SECURITY INVOKER. That diagnosis does not hold. The true cause of that
--    regression is UNKNOWN — the repo is a shallow clone and the June code is
--    not available. That file also dropped three `staff` SELECT policies, which
--    this migration deliberately does NOT touch.
--
-- 2. The parent portal never reads these tables. `family_login` returns the
--    family and all its children in one payload; app.js/lookup.js consume it as
--    `selectedFamily.students`. Of the 48 helpers in js/supabase.js that touch
--    these tables, only 7 are reachable from parent/kiosk pages, and all 7 touch
--    `registrations` / `registration_dates` only — never families or students.
--
-- 3. pg_stat_statements (complete since 2026-03-10, zero evictions) shows, out
--    of 80,992 total anon calls:
--        families  — ~10 calls   (SELECT x8, UPDATE x3)
--        students  — ~12 calls   (UPDATE x8, INSERT x2, SELECT-id x2)
--    All match admin-page query shapes (room_override, discount_*, child_dob),
--    i.e. the admin app firing before its session settles. By contrast the
--    kiosk and registration paths show thousands of calls each.
--
-- 4. The PIN-reset flow does not go through anon RLS:
--        request-pin-reset  — edge function, uses SUPABASE_SERVICE_ROLE_KEY
--        consume_pin_reset  — SECURITY DEFINER
--    Dropping `anon update families` cannot break it.
--
-- 5. R3 already revoked anon's SELECT on families.pin_hash and parent login
--    continued to work — live proof that login does not depend on anon's
--    access to `families`.
--
-- ------------------------------------------------------------
-- WHAT THIS DELIBERATELY DOES NOT TOUCH
-- ------------------------------------------------------------
--   registrations / registration_dates  — anon SELECT is load-bearing
--        (capacity counts + duplicate check, ~5,700 calls). Removing it
--        requires the RPC cutover in ss1_public_read_rpcs.sql first. Phase 2.
--   staff_clock_events                  — anon SELECT/INSERT/UPDATE are ALL
--        load-bearing; the UPDATE is how the kiosk clocks staff OUT (~1,280
--        calls). Note this contradicts R4's write-up, which lists
--        "anon update clock events" as safe to drop. It is NOT. Phase 4.
--   staff                               — 3 overlapping SELECT policies,
--        ~1,600 anon calls not yet traced. Phase 5.
--   anon INSERT on families/students    — left in place; usage not fully
--        traced and the risk is low (creating a row, not reading one).
--   REFERENCES / TRIGGER grants         — a separate repo-wide grant sweep.
-- ============================================================


-- ── PRE-FLIGHT — run this first and keep the output ──────────
-- Expect 5 policy rows (the ones dropped below) and the anon grants.
--
--   SELECT tablename, policyname, cmd, roles::text, qual, with_check
--   FROM pg_policies
--   WHERE schemaname='public' AND tablename IN ('families','students')
--   ORDER BY tablename, policyname;
--
--   SELECT table_name, string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type)
--   FROM information_schema.role_table_grants
--   WHERE table_schema='public' AND grantee='anon'
--     AND table_name IN ('families','students')
--   GROUP BY table_name;


BEGIN;

-- ============================================================
-- STEP 1 (R4) — the destructive verbs
-- ============================================================
-- `DELETE FROM students` with the public key currently wipes all 149 child
-- records. There is no soft-delete and no application-level undo.

DROP POLICY IF EXISTS "anon delete students" ON public.students;
DROP POLICY IF EXISTS "anon update students" ON public.students;
DROP POLICY IF EXISTS "anon update families" ON public.families;

-- Defense in depth: with the policies gone, RLS already denies these. But
-- TRUNCATE is NOT row-filtered by RLS — it bypasses policies entirely — so the
-- grant itself has to go. (Not reachable through PostgREST today, but holding
-- the grant means one future direct-connection path is all it takes.)
REVOKE DELETE, UPDATE, TRUNCATE ON public.students FROM anon;
REVOKE DELETE, UPDATE, TRUNCATE ON public.families FROM anon;


-- ============================================================
-- STEP 2 (R1) — the read exposure
-- ============================================================
-- These two policies are what let anyone with the public key enumerate
-- 122 families (parent names, emails, phones) and 149 children (names, DOBs).

DROP POLICY IF EXISTS "anon select students" ON public.students;
DROP POLICY IF EXISTS "anon select families" ON public.families;

-- The anon SELECT *grants* are intentionally left in place. With no SELECT
-- policy, RLS returns zero rows regardless of the grant, so protection is
-- already complete; leaving them keeps the rollback exact. (`families` holds
-- column-level SELECT grants from the R3 fix, which are now inert.) Cleaning
-- them up belongs with the repo-wide grant sweep in §9b of the analysis doc.

COMMIT;


-- ── POST-FLIGHT VERIFICATION ─────────────────────────────────
-- 1. No anon SELECT/UPDATE/DELETE policy should remain on either table.
--    Only `anon insert families` / `anon insert students` and the
--    `admin_all_*` (authenticated) policies should be listed.
--
--   SELECT tablename, policyname, cmd, roles::text
--   FROM pg_policies
--   WHERE schemaname='public' AND tablename IN ('families','students')
--   ORDER BY tablename, cmd, policyname;
--
-- 2. Prove the exposure is closed, as anon:
--
--   SET LOCAL ROLE anon;
--   SELECT count(*) FROM families;   -- expect 0 rows returned
--   SELECT count(*) FROM students;   -- expect 0 rows returned
--   RESET ROLE;
--
--   (RLS returns an empty set rather than an error. A count of 0 against
--    122/149 real rows is the pass condition.)


-- ── SMOKE TEST AFTER APPLYING (do all five) ──────────────────
--   1. Parent login at /lookup.html with a real email + PIN — must succeed and
--      must still list the family's children.
--   2. Parent registration at /index.html — submit a test month; the calendar
--      "spots left" numbers must still render.
--   3. Clock-in kiosk at /clockin.html — clock a test staff member IN and OUT.
--   4. Admin → Families tab — search, open a family, edit a child.
--   5. PIN reset — request a reset email and complete it.
--
-- If any of these fail, run ROLLBACK_r1r4_phase1_families_students.sql and
-- note WHICH step failed — that identifies the dependency this evidence missed.
