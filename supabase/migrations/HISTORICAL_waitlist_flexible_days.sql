-- Waitlist & Capacity Planner: "any N days" flexible scheduling.
-- Safe to run even if the columns already exist (guarded ADD COLUMN IF NOT EXISTS).
-- APPLY BY HAND in the Supabase SQL Editor — supabase/migrations/ is not auto-applied.

-- days_flexible: true means the parent doesn't need specific weekdays, just
-- any N days a week (days_flexible_count). When true, days_of_week is left
-- null — the Capacity Planner picks the actual weekdays at match/offer time
-- from whichever days currently have the most room.
ALTER TABLE waitlist_applications
    ADD COLUMN IF NOT EXISTS days_flexible       BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS days_flexible_count SMALLINT;
