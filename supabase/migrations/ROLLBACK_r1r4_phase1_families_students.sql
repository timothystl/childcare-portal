-- ============================================================
-- ROLLBACK for r1r4_phase1_families_students.sql
-- ============================================================
-- Restores the EXACT policy and grant state captured from production on
-- 2026-08-11 (pg_policies + information_schema.role_table_grants), so running
-- this returns the database to its pre-migration behaviour precisely.
--
-- ⚠️ Running this RE-OPENS the exposure: the public anon key regains the
--    ability to read every parent and child record and to DELETE any child
--    record. Use it only to unblock a broken flow, then report WHICH of the
--    five smoke-test steps failed so the missing dependency can be served by a
--    scoped policy or a SECURITY DEFINER RPC instead of a blanket re-open.
--
-- Safe to run more than once (drops first, then recreates).
-- ============================================================

BEGIN;

-- ── STEP 2 reversal (R1) — anon read access ──────────────────
DROP POLICY IF EXISTS "anon select families" ON public.families;
CREATE POLICY "anon select families"
    ON public.families
    AS PERMISSIVE
    FOR SELECT
    TO anon
    USING (true);

DROP POLICY IF EXISTS "anon select students" ON public.students;
CREATE POLICY "anon select students"
    ON public.students
    AS PERMISSIVE
    FOR SELECT
    TO anon
    USING (true);


-- ── STEP 1 reversal (R4) — destructive verbs ─────────────────
DROP POLICY IF EXISTS "anon update families" ON public.families;
CREATE POLICY "anon update families"
    ON public.families
    AS PERMISSIVE
    FOR UPDATE
    TO anon
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "anon update students" ON public.students;
CREATE POLICY "anon update students"
    ON public.students
    AS PERMISSIVE
    FOR UPDATE
    TO anon
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "anon delete students" ON public.students;
CREATE POLICY "anon delete students"
    ON public.students
    AS PERMISSIVE
    FOR DELETE
    TO anon
    USING (true);

-- Table grants revoked by the migration.
GRANT DELETE, UPDATE, TRUNCATE ON public.students TO anon;
GRANT DELETE, UPDATE, TRUNCATE ON public.families TO anon;

COMMIT;


-- ── VERIFY THE ROLLBACK ──────────────────────────────────────
-- Should list, for families: anon insert / anon select / anon update
--            for students: anon delete / anon insert / anon select / anon update
-- plus the authenticated admin_all_* policies.
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
--   -- expect both to include DELETE, INSERT, REFERENCES, TRIGGER, TRUNCATE, UPDATE
--   -- (students additionally has table-level SELECT; families has column-level
--   --  SELECT grants from the R3 fix, which the migration never touched)
