-- Admin/director push notification subscriptions (VAPID / Web Push).
-- ============================================================
-- Closes the gap documented in CLAUDE.md: push has existed for parents
-- (push_subscriptions) and named staff (staff_push_subscriptions) for months,
-- but nothing ever subscribed an admin login, so a new parent message sat in
-- the Parent Messages thread inbox (admin-threads.js) until someone happened
-- to open that tab.
--
-- Keyed on email, not a staff/auth row id — admins are identified by an entry
-- in the settings.admin_roles map (see policy_scoping_stage1_admin_predicate.sql
-- / is_admin() / admin_role()), not a row in any table. Case-folded to lower on
-- write so it matches admin_role()'s case-insensitive lookup.
--
-- Mirrors staff_push_subscriptions: locked to "service role only". The worker
-- (/admin-push-subscribe) verifies the caller resolves to admin_role() =
-- 'full' via their own Supabase session token before writing here — the same
-- posture as every other admin-only write in this app, so a client can never
-- insert a row for an email it doesn't hold a session for.
CREATE TABLE IF NOT EXISTS admin_push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_email text NOT NULL,
  endpoint    text NOT NULL,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(admin_email, endpoint)
);

ALTER TABLE admin_push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role only"
  ON admin_push_subscriptions
  USING (false)
  WITH CHECK (false);

-- ⚠️ SX1 (added 2026-08-19, after this migration shipped without it).
-- CREATE TABLE + ENABLE ROW LEVEL SECURITY + a policy is NOT a closed table.
-- Supabase's default privileges grant ALL on any new `public` table directly to
-- anon and authenticated at creation time, and they are invisible in the
-- migration. RLS never applies to TRUNCATE, so the grant alone let anyone
-- holding the public anon key erase every admin push subscription.
--
-- This file's header says it "mirrors staff_push_subscriptions" — which is
-- clean only because the 2026-08-14 sweep stripped its grants later. It
-- mirrored the file, not the live state. Every new-table migration needs this
-- line, and the check is `relacl`, not `pg_policies`.
--
-- Safe for both roles: the table is reached only with the service role key
-- (worker.js /admin-push-subscribe, /send-push, and the 410 cleanup).
REVOKE ALL ON admin_push_subscriptions FROM anon, authenticated, PUBLIC;
