-- ============================================================
-- ADD month_key TO registrations + UNIQUE CONSTRAINT
-- ============================================================
-- Closes the TOCTOU race where two simultaneous submissions
-- for the same child+month both pass the JS duplicate check
-- before either write completes.
--
-- 1. Adds month_key TEXT column ('YYYY-MM' of the first care date)
-- 2. Backfills existing rows from registration_dates
-- 3. Adds a partial unique index so the DB rejects any duplicate
--    confirmed registration for the same child+month
-- ============================================================

ALTER TABLE registrations ADD COLUMN IF NOT EXISTS month_key TEXT;

-- Backfill from the earliest care_date in registration_dates
UPDATE registrations r
SET month_key = to_char(
    (SELECT MIN(rd.care_date) FROM registration_dates rd WHERE rd.registration_id = r.id),
    'YYYY-MM'
)
WHERE r.month_key IS NULL;

-- Partial unique index: one confirmed registration per child+month.
-- Case-insensitive on child_name; only blocks 'confirmed' status to
-- allow admins to create duplicate drafts/pending entries if needed.
CREATE UNIQUE INDEX IF NOT EXISTS registrations_child_month_unique
ON registrations (lower(child_name), month_key)
WHERE status = 'confirmed';
