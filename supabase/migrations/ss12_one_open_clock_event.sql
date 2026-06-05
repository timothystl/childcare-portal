-- ============================================================
-- SS12 — Prevent overlapping (duplicate) open clock-ins
-- ============================================================
-- Nothing stops two open (clock_out IS NULL) rows for the same staff+day, so a
-- double-tap or two kiosk tabs can create two open shifts and double-count hours.
-- A partial unique index allows at most ONE open shift per staff per work_date,
-- while still allowing multiple completed shifts in a day (those have a clock_out
-- and are excluded by the WHERE clause).
--
-- ⚠️ If there are already duplicate open shifts, the index creation will FAIL.
-- Find and resolve them first (close or delete the stray open rows):
--   SELECT staff_id, work_date, count(*)
--   FROM staff_clock_events
--   WHERE clock_out IS NULL
--   GROUP BY staff_id, work_date
--   HAVING count(*) > 1;
--
-- After this, a duplicate clock-in attempt fails at the DB; the kiosk surfaces
-- the error (clockin.html already shows insert errors). Optional follow-up: make
-- that error message friendlier ("You're already clocked in").
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS staff_clock_events_one_open_per_day
ON staff_clock_events (staff_id, work_date)
WHERE clock_out IS NULL;
