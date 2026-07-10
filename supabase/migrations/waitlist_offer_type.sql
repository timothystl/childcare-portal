-- Waitlist & Capacity Planner: distinguish full vs. partial spot offers.
-- Safe to run even if the columns already exist (guarded ADD COLUMN IF NOT EXISTS).
-- APPLY BY HAND in the Supabase SQL Editor — supabase/migrations/ is not auto-applied.

-- offer_type: 'full' (every requested day was offered) or 'partial' (only some
-- of the requested days were open at offer time). offered_days records exactly
-- which days were offered, independent of days_of_week (the original request) —
-- so a later "offer the remaining days" flow can diff the two.
ALTER TABLE waitlist_applications
    ADD COLUMN IF NOT EXISTS offer_type    TEXT,
    ADD COLUMN IF NOT EXISTS offered_days  TEXT;
