-- Add change_fee column to registration_dates
-- Tracks the $5 admin change fee when a day is added post-submission
ALTER TABLE registration_dates
  ADD COLUMN IF NOT EXISTS change_fee NUMERIC(6,2) DEFAULT 0;
