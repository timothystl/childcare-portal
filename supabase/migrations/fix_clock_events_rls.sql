-- Migration: Tighten RLS on staff_clock_events
-- Problem: The original "anon update clock events" policy allows any anonymous
-- user (anyone with the public anon key) to modify ANY clock record for ANY
-- date, enabling payroll fraud via direct API calls.
--
-- Fix: Replace the unrestricted anon UPDATE policy with one that only allows
-- updating a record for today's date. This prevents retroactive manipulation
-- of past clock entries while still allowing normal clock-out operations.
--
-- Run this in your Supabase SQL editor (Dashboard → SQL Editor).

-- 1. Drop the old unrestricted anon policies
DROP POLICY IF EXISTS "anon insert clock events" ON staff_clock_events;
DROP POLICY IF EXISTS "anon update clock events" ON staff_clock_events;

-- 2. Re-create INSERT restricted to today only
--    (staff can only create a clock record for the current date)
CREATE POLICY "anon insert clock events today only"
    ON staff_clock_events
    FOR INSERT TO anon
    WITH CHECK (work_date = CURRENT_DATE);

-- 3. Re-create UPDATE restricted to today only
--    (staff can only update a clock record where the work_date is today)
CREATE POLICY "anon update clock events today only"
    ON staff_clock_events
    FOR UPDATE TO anon
    USING     (work_date = CURRENT_DATE)
    WITH CHECK (work_date = CURRENT_DATE);
