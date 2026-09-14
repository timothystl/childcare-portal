-- The center is closed at weekends: the kiosk calendar offers Mon-Fri only
-- and the admin UI indexes a five-entry day array, so a weekend weekday
-- would render as "undefined, every week" and never match a scheduling week.
-- Tighten the constraint from 0..6 to 0..4 (Mon..Fri). The table is new and
-- empty, so there is nothing to migrate.
ALTER TABLE public.staff_time_off_requests
    DROP CONSTRAINT IF EXISTS staff_time_off_weekday_range;

ALTER TABLE public.staff_time_off_requests
    ADD CONSTRAINT staff_time_off_weekday_range
    CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 4);
