-- Schedule reconcile-anet-payments once a day. Mirrors
-- schedule_day_summary_APPLIED.sql's pattern (pg_cron + pg_net calling an
-- edge function with the service role key, both already enabled in this
-- project — see setup_missed_clock_cron.sql / schedule_day_summary_APPLIED.sql).
--
-- ⚠️ BEFORE RUNNING ELSEWHERE: replace {SERVICE_ROLE_KEY} with the real key.
-- The live job carries it inline (same as the other jobs); not committed here.
--
-- 10:00 UTC = 5am Central, well after Authorize.net's own nightly batch
-- settlement, so a charge from yesterday has had time to either arrive via
-- webhook or show up in getSettledBatchListRequest. Runs every day, not
-- just weekdays — a parent can pay from home on a Saturday even though the
-- center is closed.

SELECT cron.schedule(
  'reconcile-anet-payments',
  '0 10 * * *',
  $job$
    select net.http_post(
      url     := 'https://dahdstopsumxnqvdclmy.supabase.co/functions/v1/reconcile-anet-payments',
      headers := '{"Authorization": "Bearer {SERVICE_ROLE_KEY}", "Content-Type": "application/json"}'::jsonb,
      body    := '{}'::jsonb
    )
  $job$
);
