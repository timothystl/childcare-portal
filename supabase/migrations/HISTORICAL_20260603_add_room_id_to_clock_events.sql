-- Add room_id to staff_clock_events so the kiosk can record which room each staff
-- member worked in at clock-in time.  NULL on existing rows; new events populated
-- going forward.  Used for per-room labor cost allocation in the Finance P&L report.
ALTER TABLE staff_clock_events ADD COLUMN IF NOT EXISTS room_id text;
