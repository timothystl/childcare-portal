-- ============================================================
-- FS1 — populate registrations.month_key (index deferred)
-- ============================================================
-- The original add_registration_month_key.sql was never applied in prod
-- (2026-07-12 catalog check: column + index both absent), and
-- submitRegistration() never set the column, so the duplicate-prevention
-- unique index it was written for could never fire.
--
-- This migration applies the SAFE, non-destructive half:
--   1. adds the month_key column (nullable), and
--   2. backfills it from each registration's earliest care_date.
-- js/supabase.js now stamps month_key on every new insert (FS1 code half).
--
-- The partial UNIQUE INDEX is intentionally NOT created here: prod already
-- contains ~38 groups of duplicate confirmed (child_name, month) rows
-- (pre-existing, from the FS2 admin flow and parent re-registration), so
-- CREATE UNIQUE INDEX would fail. Run fs1_registration_month_key_index.sql
-- (below) only AFTER those duplicates have been reconciled.
-- ============================================================

ALTER TABLE registrations ADD COLUMN IF NOT EXISTS month_key TEXT;

-- Backfill from the earliest care_date in registration_dates
UPDATE registrations r
SET month_key = to_char(
    (SELECT MIN(rd.care_date) FROM registration_dates rd WHERE rd.registration_id = r.id),
    'YYYY-MM'
)
WHERE r.month_key IS NULL
  AND EXISTS (SELECT 1 FROM registration_dates rd WHERE rd.registration_id = r.id);
