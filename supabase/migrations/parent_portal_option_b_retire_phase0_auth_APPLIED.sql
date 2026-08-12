-- APPLIED TO PRODUCTION 2026-08-12 (supabase_migrations version 20260812044148).
-- ============================================================
-- Retire the Phase 0 hand-rolled parent auth
-- ============================================================
-- Phase 0 signed its own HS256 tokens with the project's LEGACY JWT secret and
-- kept its own refresh-token table and its own Postgres role. Option B replaced
-- all three with real Supabase Auth users, so these are now dead weight — and
-- dead auth machinery is worse than no auth machinery, because the next person
-- to read the schema cannot tell it is not the design.
--
-- Verified before dropping: parent_refresh_tokens held 0 rows, and
-- parent_portal was never switched into by anything (its only members are the
-- implicit postgres + authenticator memberships created with the role).
--
-- What replaces them: parent_accounts (user_id -> family_id) and
-- parent_family_ids(), read by every parent RLS policy off a genuine JWT.
--
-- NOTE: parent_portal_phase0.sql in this directory still CREATEs both objects.
-- It is kept for history; do not re-run it.

DROP TABLE IF EXISTS public.parent_refresh_tokens;

-- Privileges the role picked up incidentally from grants that ran while it
-- existed. Revoked by hand rather than with DROP OWNED BY, which the migration
-- connection lacks the membership to run.
REVOKE ALL ON SCHEMA   public              FROM parent_portal;
REVOKE ALL ON FUNCTION public.is_admin()   FROM parent_portal;
REVOKE ALL ON FUNCTION public.admin_role() FROM parent_portal;

-- authenticator holding this membership is what would have let a JWT ask
-- PostgREST to become parent_portal.
REVOKE parent_portal FROM authenticator;
REVOKE parent_portal FROM postgres;
DROP ROLE IF EXISTS parent_portal;
