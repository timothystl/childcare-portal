-- Waitlist inquiry form + tour reminder tracking.
-- Safe to run even if waitlist_applications already exists (all IF NOT EXISTS / guarded).
-- APPLY BY HAND in the Supabase SQL Editor — supabase/migrations/ is not auto-applied.

-- ── Base table (canonical version of the schema previously documented only as a
--    comment in js/supabase.js) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS waitlist_applications (
    id                 BIGSERIAL PRIMARY KEY,
    applied_at         TIMESTAMPTZ DEFAULT NOW(),
    status             TEXT        DEFAULT 'pending',
    parent_name        TEXT        NOT NULL,
    parent_email       TEXT        NOT NULL,
    parent_phone       TEXT,
    child_name         TEXT        NOT NULL,
    child_dob          DATE,
    expected_due_date  DATE,
    desired_start_date DATE        NOT NULL,
    start_flexibility  TEXT        DEFAULT 'flexible',
    days_of_week       TEXT,
    day_type           TEXT        DEFAULT 'full',
    has_sibling        BOOLEAN     DEFAULT FALSE,
    sibling_child_name TEXT,
    sibling_room_id    TEXT,
    notes              TEXT,
    offered_at         TIMESTAMPTZ,
    offer_deadline     DATE,
    offer_notes        TEXT,
    paperwork_received BOOLEAN     DEFAULT FALSE,
    deposit_paid       BOOLEAN     DEFAULT FALSE,
    archived_at        TIMESTAMPTZ,
    archive_reason     TEXT
);

ALTER TABLE waitlist_applications ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "Public insert" ON waitlist_applications FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "Auth all" ON waitlist_applications FOR ALL USING (auth.role() = 'authenticated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── New columns: inquiry-form timestamping, tour scheduling, reminder tracking ──
ALTER TABLE waitlist_applications
    ADD COLUMN IF NOT EXISTS interest_token                 UUID DEFAULT gen_random_uuid(),
    ADD COLUMN IF NOT EXISTS confirmation_sent_at            TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS tour_status                     TEXT DEFAULT 'not_scheduled',
    ADD COLUMN IF NOT EXISTS tour_scheduled_at               TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS tour_notes                      TEXT,
    ADD COLUMN IF NOT EXISTS tour_completed_at               TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_reminder_sent_at           TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reminder_count                  INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS still_interested_confirmed_at   TIMESTAMPTZ;

-- Backfill tokens for any pre-existing rows inserted before this column existed.
UPDATE waitlist_applications SET interest_token = gen_random_uuid() WHERE interest_token IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS waitlist_applications_interest_token_idx
    ON waitlist_applications (interest_token);

-- interest_token is looked up anonymously (from the tour-reminder confirm-interest
-- link) via the confirm-waitlist-interest edge function using the service-role key,
-- so no additional RLS policy is needed for it — the anon key never reads this table
-- directly for that flow.

-- ── Scheduled tour/re-confirm reminders ─────────────────────────────────────
-- BEFORE RUNNING: replace {SUPABASE_URL} and {SERVICE_ROLE_KEY} with real values.
-- Requires pg_cron and pg_net extensions enabled in your Supabase project
-- (same pattern as setup_missed_clock_cron.sql). Runs every Monday at 9am UTC;
-- the edge function itself decides who's actually due for a reminder.
SELECT cron.schedule(
  'send-waitlist-reminders',
  '0 9 * * 1',
  $$
    SELECT net.http_post(
      url     := '{SUPABASE_URL}/functions/v1/send-waitlist-reminders',
      headers := '{"Authorization": "Bearer {SERVICE_ROLE_KEY}", "Content-Type": "application/json"}'::jsonb,
      body    := '{}'::jsonb
    )
  $$
);
