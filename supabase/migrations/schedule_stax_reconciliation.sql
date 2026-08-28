-- Schedule reconcile-stax-payments every 30 minutes. Mirrors
-- schedule_anet_reconciliation.sql's pattern (pg_cron + pg_net calling an
-- edge function with the service role key, both already enabled in this
-- project).
--
-- ⚠️ BEFORE RUNNING ELSEWHERE: replace {SERVICE_ROLE_KEY} with the real key.
-- The live job carries it inline (same as the other jobs); not committed here.
--
-- Every 30 minutes, not once a day like the Authorize.net job — a Stax
-- charge resolves synchronously in seconds, not overnight in a settlement
-- batch, so a lock stuck 'pending'/'ambiguous' from a missed webhook should
-- be caught and released within a reasonable window, not up to 24 hours.
-- reconcile-stax-payments only acts on a lock once it's been stale for at
-- least 15 minutes (STALE_MINUTES) and only fully releases one with no
-- matching Stax transaction after 2 hours (RELEASE_HOURS) — the frequent
-- schedule just means those windows are checked promptly, not that
-- anything fires sooner than the function's own grace periods allow.
--
-- Applied 2026-08-28 in response to an external security review finding:
-- with no reconciliation job, a family whose webhook was missed stayed
-- permanently blocked from paying online again by
-- payment_charge_locks_active_family_idx (see harden_stax_payments.sql).

SELECT cron.schedule(
  'reconcile-stax-payments',
  '*/30 * * * *',
  $job$
    select net.http_post(
      url     := 'https://dahdstopsumxnqvdclmy.supabase.co/functions/v1/reconcile-stax-payments',
      headers := '{"Authorization": "Bearer {SERVICE_ROLE_KEY}", "Content-Type": "application/json"}'::jsonb,
      body    := '{}'::jsonb
    )
  $job$
);
