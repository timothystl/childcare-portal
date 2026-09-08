-- Remove legacy policy aliases found during post-migration verification.
-- These duplicates would otherwise preserve broader restricted-admin access.

BEGIN;

DROP POLICY IF EXISTS "admin all settings" ON public.settings;
DROP POLICY IF EXISTS "admin only" ON public.staff_injury_reports;

COMMIT;
