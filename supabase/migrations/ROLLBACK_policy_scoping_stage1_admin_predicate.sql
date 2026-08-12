-- ============================================================
-- ROLLBACK — policy_scoping_stage1_admin_predicate.sql
-- ============================================================
-- Stage 1 changed no policies, so dropping these functions restores the
-- previous state exactly. Nothing reads them yet.
--
-- ⚠️ ONLY safe while stages 2–5 are unapplied. Once any policy is written
-- `USING (is_admin())`, dropping the function makes that policy unevaluable and
-- locks every admin out of that table. Check first:
--
--   SELECT schemaname, tablename, policyname, qual
--   FROM pg_policies
--   WHERE schemaname = 'public'
--     AND (qual LIKE '%is_admin%' OR qual LIKE '%admin_role%'
--          OR with_check LIKE '%is_admin%' OR with_check LIKE '%admin_role%');
--
-- Expect zero rows. If there are any, roll those stages back first.
-- ============================================================

DROP FUNCTION IF EXISTS public.is_admin();
DROP FUNCTION IF EXISTS public.admin_role();
