-- Add Time In / Time Out / Room fields to staff_hours for the unified payroll entry view.
-- Allows admins to enter shift start/end times instead of decimal hours.
-- hours_worked is preserved for backward compatibility and derived from time_in/time_out on save.

ALTER TABLE staff_hours
  ADD COLUMN IF NOT EXISTS time_in  TIME,
  ADD COLUMN IF NOT EXISTS time_out TIME,
  ADD COLUMN IF NOT EXISTS room_id  TEXT;
