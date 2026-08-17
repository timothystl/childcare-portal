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
