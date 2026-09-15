-- APPLIED TO PRODUCTION 2026-08-12.
-- ============================================================
-- Schedule the daily-photo retention sweep
-- ============================================================
-- ⚠️ BEFORE RUNNING ELSEWHERE: replace {SERVICE_ROLE_KEY} with the real key.
-- The live job carries it inline (same as check-missed-clocks and
-- send-waitlist-reminders); it is NOT committed here.
--
-- WHY THIS EXISTS: portal.html tells parents daily photos are "saved for about
-- a week". Until something called sweep_expired_child_photos(), that sentence
-- was false and the photos would have sat in the bucket forever. A retention
-- promise with no sweeper is just a claim.
--
-- 08:15 UTC = 3:15am Central — well clear of the care day, so a parent never
-- watches a photo vanish mid-scroll.
--
-- The edge function deletes the storage objects; the RPC deletes the rows and
-- returns their paths. Rows first, deliberately: an orphaned object is
-- invisible and recoverable, an orphaned row renders as a broken photo.

SELECT cron.schedule(
  'sweep-child-photos',
  '15 8 * * *',
  $job$
    select net.http_post(
      url     := 'https://dahdstopsumxnqvdclmy.supabase.co/functions/v1/sweep-child-photos',
      headers := '{"Authorization": "Bearer {SERVICE_ROLE_KEY}", "Content-Type": "application/json"}'::jsonb,
      body    := '{}'::jsonb
    )
  $job$
);

-- ============================================================
-- VERIFIED AFTER APPLYING (rolled back)
-- ============================================================
-- Four rows seeded: an expired daily, a fresh daily, an incident expired 400
-- days ago, and an incident with no expiry.
--   swept:        old/daily-expired.jpg only
--   left behind:  new/daily-fresh.jpg, old/incident.jpg, old/incident-null.jpg
-- Incident photographs are evidence — guidelines 3 years, statute of
-- limitations 5, major injury until the child is 23. No cron decides when that
-- documentation stops existing; the director removes those by hand.
