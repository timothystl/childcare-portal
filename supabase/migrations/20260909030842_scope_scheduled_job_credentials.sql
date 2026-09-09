-- Replace broad service-role JWTs embedded in pg_cron commands with one
-- purpose-specific secret. Before applying this migration, create matching
-- CRON_SECRET values in Edge Function secrets and Supabase Vault under the
-- name `mymdo_cron_secret`. The value itself must never appear in SQL/history.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'mymdo_cron_secret'
  ) THEN
    RAISE EXCEPTION 'Vault secret mymdo_cron_secret must exist before this migration is applied';
  END IF;
END
$$;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname IN (
  'check-missed-clocks',
  'send-waitlist-reminders',
  'sweep-child-photos',
  'send-day-summary',
  'reconcile-stax-payments'
);

SELECT cron.schedule('check-missed-clocks', '*/15 7-18 * * 1-5', $job$
  SELECT net.http_post(
    url := 'https://dahdstopsumxnqvdclmy.supabase.co/functions/v1/check-missed-clocks',
    headers := jsonb_build_object(
      'X-Cron-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'mymdo_cron_secret'),
      'Content-Type', 'application/json'
    ), body := '{}'::jsonb
  )
$job$);

SELECT cron.schedule('send-waitlist-reminders', '0 9 * * 1', $job$
  SELECT net.http_post(
    url := 'https://dahdstopsumxnqvdclmy.supabase.co/functions/v1/send-waitlist-reminders',
    headers := jsonb_build_object(
      'X-Cron-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'mymdo_cron_secret'),
      'Content-Type', 'application/json'
    ), body := '{}'::jsonb
  )
$job$);

SELECT cron.schedule('sweep-child-photos', '15 8 * * *', $job$
  SELECT net.http_post(
    url := 'https://dahdstopsumxnqvdclmy.supabase.co/functions/v1/sweep-child-photos',
    headers := jsonb_build_object(
      'X-Cron-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'mymdo_cron_secret'),
      'Content-Type', 'application/json'
    ), body := '{}'::jsonb
  )
$job$);

SELECT cron.schedule('send-day-summary', '0 23 * * 1-5', $job$
  SELECT net.http_post(
    url := 'https://dahdstopsumxnqvdclmy.supabase.co/functions/v1/send-day-summary',
    headers := jsonb_build_object(
      'X-Cron-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'mymdo_cron_secret'),
      'Content-Type', 'application/json'
    ), body := '{}'::jsonb
  )
$job$);

SELECT cron.schedule('reconcile-stax-payments', '*/30 * * * *', $job$
  SELECT net.http_post(
    url := 'https://dahdstopsumxnqvdclmy.supabase.co/functions/v1/reconcile-stax-payments',
    headers := jsonb_build_object(
      'X-Cron-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'mymdo_cron_secret'),
      'Content-Type', 'application/json'
    ), body := '{}'::jsonb
  )
$job$);
