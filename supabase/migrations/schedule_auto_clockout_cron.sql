-- ============================================================
-- SCHEDULED AUTO CLOCK-OUT — pg_cron + pg_net
--
-- Prerequisites (run once via Supabase SQL editor):
--   1. Enable pg_cron extension:
--        CREATE EXTENSION IF NOT EXISTS pg_cron;
--        GRANT USAGE ON SCHEMA cron TO postgres;
--   2. Enable pg_net extension:
--        CREATE EXTENSION IF NOT EXISTS pg_net;
--   3. Set the CRON_SECRET Postgres config variable so the edge
--      function can verify calls come from the cron job:
--        ALTER DATABASE postgres
--          SET app.cron_secret = '<generate-a-random-string>';
--      Then reload: SELECT pg_reload_conf();
--   4. Deploy the 'auto-clockout-check' edge function and set
--      its secrets in Supabase dashboard → Edge Functions → Secrets:
--        CRON_SECRET           = <same value as above>
--        RESEND_API_KEY        = <your Resend API key>
--        RESEND_FROM_EMAIL     = <sender address>
--        RESEND_REPLY_TO       = <director email>
--        SUPABASE_URL          = https://dahdstopsumxnqvdclmy.supabase.co
--        SUPABASE_SERVICE_ROLE_KEY = <service role key>
-- ============================================================

-- Remove any existing schedule to avoid duplicates on re-run
SELECT cron.unschedule('auto-clockout-check')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'auto-clockout-check'
  );

-- Schedule every 15 minutes on weekdays (Mon–Fri).
-- The edge function itself enforces the 8:15 am – 5:00 pm
-- America/Chicago window and the 5 pm hard cutoff,
-- so the cron can safely fire 24/7 without side effects.
SELECT cron.schedule(
    'auto-clockout-check',
    '*/15 * * * 1-5',
    $$
    SELECT net.http_post(
        url     := 'https://dahdstopsumxnqvdclmy.supabase.co/functions/v1/auto-clockout-check',
        headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || current_setting('app.cron_secret', true)
        ),
        body    := '{}'::jsonb
    );
    $$
);
