-- Schedule the check-missed-clocks edge function every 15 min on weekday mornings.
-- BEFORE RUNNING: replace {SUPABASE_URL} and {SERVICE_ROLE_KEY} with real values.
-- Requires pg_cron and pg_net extensions enabled in your Supabase project.

SELECT cron.schedule(
  'check-missed-clocks',
  '*/15 7-18 * * 1-5',
  $$
    SELECT net.http_post(
      url     := '{SUPABASE_URL}/functions/v1/check-missed-clocks',
      headers := '{"Authorization": "Bearer {SERVICE_ROLE_KEY}", "Content-Type": "application/json"}'::jsonb,
      body    := '{}'::jsonb
    )
  $$
);
