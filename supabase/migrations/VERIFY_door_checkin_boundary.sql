-- ============================================================
-- VERIFY — read-only checks to run AFTER applying
-- PROPOSED_before_after_care_charges.sql
-- ============================================================
-- Not a migration. No version prefix, so nothing runs it in sequence; paste
-- it into the SQL Editor by hand and read the answers.
--
-- Every query below exists because of a specific way the door kiosk could
-- quietly go wrong. `record_door_checkin` lets an UNAUTHENTICATED wall
-- tablet create a family, a child, and a charge. That is a deliberate,
-- narrow hole, and these are the checks that prove it stayed narrow.
--
-- Expected answers are stated next to each query. Anything else is a stop.
-- ============================================================


-- ── 1. anon can reach the RPC and NOTHING ELSE ──────────────
-- EXPECT: exactly one row — record_door_checkin. If care_charges or any
-- other care function appears here, anon can write billing data directly
-- and the whole design is void.
SELECT p.proname, a.grantee, a.privilege_type
  FROM information_schema.routine_privileges a
  JOIN pg_proc p ON p.proname = a.routine_name
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
 WHERE a.grantee = 'anon'
   AND (p.proname LIKE '%care%' OR p.proname LIKE '%door%')
 ORDER BY p.proname;

-- ── 2. The table itself is closed to anon ───────────────────
-- EXPECT: zero rows. Any grant here is a direct write path that bypasses
-- the PIN check entirely.
SELECT grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public' AND table_name = 'care_charges'
   AND grantee IN ('anon', 'PUBLIC');

-- ── 3. RLS is on, and every policy names a role ─────────────
-- EXPECT: rowsecurity = true, and one policy whose roles are {authenticated}
-- — never {public}, which silently includes authenticated and is wider than
-- it reads.
SELECT c.relrowsecurity AS rls_enabled,
       pol.polname,
       ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(pol.polroles)) AS roles
  FROM pg_class c
  LEFT JOIN pg_policy pol ON pol.polrelid = c.oid
 WHERE c.relname = 'care_charges';

-- ── 4. The RPC actually verifies a PIN ──────────────────────
-- EXPECT: true. If staff_id_for_pin has been edited out, the hallway tablet
-- creates billing records for anyone who taps it.
SELECT pg_get_functiondef(p.oid) LIKE '%staff_id_for_pin%' AS checks_staff_pin,
       p.prosecdef AS security_definer
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'record_door_checkin';


-- ============================================================
-- ONGOING — the queries worth running weekly, not just once
-- ============================================================

-- ── 5. Provisional families nobody has completed ────────────
-- These are real families being billed with no email address, so their
-- invoice reaches nobody. This is the office's worklist; it should be
-- SHORT and it should EMPTY OUT. A name sitting here for a month means the
-- door flow is being used as a way to avoid paperwork.
SELECT f.id, f.parent_name, f.parent_phone,
       f.provisional_at::date AS created,
       (now()::date - f.provisional_at::date) AS days_open,
       count(cc.id) AS charges,
       coalesce(sum(cc.rate_charged) FILTER (WHERE NOT cc.waived), 0) AS owed
  FROM families f
  LEFT JOIN care_charges cc ON cc.family_id = f.id
 WHERE f.provisional_at IS NOT NULL AND f.completed_at IS NULL
 GROUP BY f.id
 ORDER BY f.provisional_at;

-- ── 6. Children whose allergies were never reviewed ─────────
-- ⚠️ SAFETY, not billing. A door-created child has an EMPTY allergy list,
-- which reads like "no allergies" to anyone who does not check
-- allergies_reviewed_at. Nobody has asked this child's parent anything.
-- EXPECT: empty, or a list the office is actively working through.
SELECT s.id, s.child_name, f.parent_name, f.parent_phone,
       f.provisional_at::date AS at_door_on
  FROM students s
  JOIN families f ON f.id = s.family_id
 WHERE s.allergies_reviewed_at IS NULL
   AND f.provisional_at IS NOT NULL
 ORDER BY f.provisional_at;

-- ── 7. Charges that can never be collected ──────────────────
-- EXPECT: zero rows, and the NOT NULL family_id is what makes that true.
-- If this ever returns anything, a charge is owed by a family that cannot
-- be invoiced, and it will not show up anywhere else.
SELECT cc.id, cc.care_date, cc.program_id, cc.rate_charged
  FROM care_charges cc
  LEFT JOIN families f ON f.id = cc.family_id
 WHERE f.id IS NULL
    OR coalesce(btrim(f.parent_email), '') = '';

-- ── 8. Anyone past the provisional cap ──────────────────────
-- The RPC refuses beyond PROVISIONAL_MAX_SESSIONS, so this should be empty.
-- A row here means the cap was raised, bypassed, or the charges were
-- written by something other than the door RPC — worth knowing which.
SELECT f.id, f.parent_name, count(cc.id) AS charges
  FROM families f
  JOIN care_charges cc ON cc.family_id = f.id
 WHERE f.provisional_at IS NOT NULL AND f.completed_at IS NULL
 GROUP BY f.id
HAVING count(cc.id) > 2
 ORDER BY count(cc.id) DESC;
