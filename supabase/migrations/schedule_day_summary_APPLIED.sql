-- APPLIED TO PRODUCTION 2026-08-12.
-- ⚠️ BEFORE RUNNING ELSEWHERE: replace {SERVICE_ROLE_KEY} with the real key.
-- The live job carries it inline (same as the other jobs); not committed here.
--
-- 23:00 UTC = 6pm Central, an hour after the 5pm close, so late pickups are
-- already logged. Weekdays only — the centre is closed at weekends and a
-- Saturday summary would be noise.
--
-- WHY A SUMMARY AT ALL: the notification policy is that messages, one photo a
-- day, and incidents interrupt a parent, and everything else waits. A parent
-- pinged for each diaper stops reading the pings — and then the incident
-- notification, the one that matters, arrives in a stream they have learned to
-- ignore. One notification per FAMILY, not per child.

SELECT cron.schedule(
  'send-day-summary',
  '0 23 * * 1-5',
  $job$
    select net.http_post(
      url     := 'https://dahdstopsumxnqvdclmy.supabase.co/functions/v1/send-day-summary',
      headers := '{"Authorization": "Bearer {SERVICE_ROLE_KEY}", "Content-Type": "application/json"}'::jsonb,
      body    := '{}'::jsonb
    )
  $job$
);
