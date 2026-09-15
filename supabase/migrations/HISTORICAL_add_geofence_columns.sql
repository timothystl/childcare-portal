-- Add geolocation columns to staff_clock_events for geofence tracking
ALTER TABLE staff_clock_events
  ADD COLUMN IF NOT EXISTS clock_in_lat             float8,
  ADD COLUMN IF NOT EXISTS clock_in_lon             float8,
  ADD COLUMN IF NOT EXISTS clock_in_outside_fence   boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS clock_out_lat            float8,
  ADD COLUMN IF NOT EXISTS clock_out_lon            float8,
  ADD COLUMN IF NOT EXISTS clock_out_outside_fence  boolean DEFAULT false;
