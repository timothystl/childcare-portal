-- Phase 0 — SX1, SX9, SX11.

-- ── SX1 ──────────────────────────────────────────────────────────────────
-- admin_push_subscriptions held the full Supabase default grant for anon AND
-- authenticated (arwdDxtm), including TRUNCATE. RLS never applies to TRUNCATE,
-- so the grant alone was sufficient: anyone holding the public anon key, which
-- ships in the browser on every page, could erase every admin push
-- subscription. The failure mode is silence -- the director simply stops
-- receiving push for new parent messages and incidents, with nothing to say why.
--
-- This is the 2026-08-14 TRUNCATE finding reopened on a table created three
-- days after the sweep that closed it, because add_admin_push_subscriptions.sql
-- created the table, enabled RLS and added a USING(false) policy but never
-- revoked Supabase's defaults.
--
-- Safe to revoke from BOTH roles: worker.js reaches this table only with the
-- service role key (/admin-push-subscribe insert, /send-push select, the 410
-- cleanup delete), and the service role bypasses grants and RLS alike. No
-- browser path touches it.
REVOKE ALL ON public.admin_push_subscriptions FROM anon, authenticated, PUBLIC;

-- ── SX9 ──────────────────────────────────────────────────────────────────
-- The only function in the schema with a mutable search_path. SECURITY INVOKER,
-- so the risk is small, but it is a trigger function on a billing-adjacent
-- table and there is no reason to leave it resolvable against a caller-set path.
ALTER FUNCTION public.prevent_duplicate_care_date() SET search_path = 'public', 'pg_temp';

-- ── SX11 ─────────────────────────────────────────────────────────────────
-- pg_trgm was installed in `public`. Verified before moving: zero indexes use
-- trgm operator classes, and the only functions referencing similarity()/<->
-- are pg_trgm's own. Nothing in this app uses it, so the move cannot break a
-- query today.
-- ⚠️ If anything later WANTS trigram search, the pinned `search_path` on our
-- SECURITY DEFINER functions is 'public'/'public,pg_temp' -- it will not find
-- similarity() in `extensions` unless that function's search_path includes it.
ALTER EXTENSION pg_trgm SET SCHEMA extensions;
