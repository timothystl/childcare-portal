-- ============================================================
-- ROLLBACK — parent_portal_phase0.sql
-- ============================================================
-- ⚠️ Dropping the students columns DESTROYS the allergy data, which is
-- hand-transcribed from paper enrollment forms for 149 children and is a
-- child-safety record. Export it first:
--
--   SELECT id, child_name, allergies, care_notes, photo_release
--   FROM students WHERE jsonb_array_length(allergies) > 0 OR care_notes IS NOT NULL;
--
-- Steps 1 and 2 are safe and reversible. Step 3 is not — it is commented out
-- deliberately and should only be run with the export in hand.
-- ============================================================

-- 1. Sessions.
DROP TABLE IF EXISTS public.parent_refresh_tokens;

-- 2. The parent role. Safe: it never held any table privileges.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'parent_portal') THEN
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO parent_portal;
        REVOKE USAGE ON SCHEMA public FROM parent_portal;
        REVOKE parent_portal FROM authenticator;
        DROP ROLE parent_portal;
    END IF;
END $$;

-- 3. Child safety data. DESTRUCTIVE — export first, then uncomment.
-- ALTER TABLE public.students DROP CONSTRAINT IF EXISTS students_allergies_shape;
-- DROP INDEX IF EXISTS public.students_has_allergies_idx;
-- ALTER TABLE public.students
--     DROP COLUMN IF EXISTS allergies,
--     DROP COLUMN IF EXISTS care_notes,
--     DROP COLUMN IF EXISTS photo_release;
