-- ============================================================
-- SS1 (groundwork) — SECURITY DEFINER RPCs for the public reads
-- ============================================================
-- The public (anon) app currently reads `registrations` and `registration_dates`
-- directly with USING(true) policies, which lets anyone enumerate all parent
-- emails + child names. The app only needs (a) capacity counts and (b) a
-- duplicate-registration check — both of which can be served by definer RPCs
-- that return ONLY counts/booleans, exposing no PII.
--
-- This migration just CREATES the functions; it changes no policies and breaks
-- nothing on its own. The tightening is a SEQUENCED follow-up (see bottom).
-- ============================================================

-- (a) Capacity counts for a room over a set of dates (replaces the anon SELECT
--     in fetchCapacityForDates).
CREATE OR REPLACE FUNCTION public.capacity_counts(p_room_id text, p_dates date[])
RETURNS TABLE(care_date date, cnt int)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT rd.care_date, count(*)::int
    FROM registration_dates rd
    WHERE rd.room_id = p_room_id
      AND rd.waitlisted = false
      AND rd.care_date = ANY(p_dates)
    GROUP BY rd.care_date;
$$;
GRANT EXECUTE ON FUNCTION public.capacity_counts(text, date[]) TO anon;

-- (b) Does a confirmed (non-waitlisted) registration already exist this month
--     for this child (optionally scoped to an email)? Returns the conflict's
--     child_name + created_at for the parent-facing message — no other PII.
CREATE OR REPLACE FUNCTION public.registration_conflict(
    p_month_key text,          -- 'YYYY-MM'
    p_child_name text,
    p_email      text DEFAULT NULL
)
RETURNS TABLE(child_name text, created_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT r.child_name, r.created_at
    FROM registrations r
    JOIN registration_dates rd ON rd.registration_id = r.id
    WHERE lower(r.child_name) = lower(p_child_name)
      AND (p_email IS NULL OR lower(r.parent_email) = lower(p_email))
      AND rd.waitlisted = false
      AND rd.care_date >= (p_month_key || '-01')::date
      AND rd.care_date <  ((p_month_key || '-01')::date + interval '1 month')
    ORDER BY r.created_at
    LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.registration_conflict(text, text, text) TO anon;

-- ============================================================
-- SEQUENCED FOLLOW-UP (do NOT do all at once — test each step):
--   1. Apply this migration (creates the RPCs; safe, no behavior change).
--   2. Switch the frontend to the RPCs (then deploy):
--        - fetchCapacityForDates            -> rpc('capacity_counts', ...)
--        - checkExistingRegistration        -> rpc('registration_conflict', ...)
--        - checkExistingRegistrationByChild -> rpc('registration_conflict', ...)
--   3. Verify registration + the calendar "spots left" still work in staging.
--   4. THEN drop the wide-open anon policies (separate migration):
--        DROP POLICY "anon select registrations"      ON registrations;
--        DROP POLICY "anon select registration_dates" ON registration_dates;
--        DROP POLICY "anon select families"/"anon update families" ON families;
--        DROP POLICY "anon select/update/delete students"          ON students;
--        DROP POLICY "Anon PIN lookup"/"anon read active staff"    ON staff;
--      (families/students/staff anon policies are vestigial — verified no
--       non-admin code uses those tables directly; parent/kiosk flows use
--       definer RPCs + service-role edge functions.)
--   NOTE: the earlier blanket drop broke parent login; that was a separate
--   staff-migration issue, but still — do step 4 last, and test login + kiosk
--   + registration in staging before prod.
-- ============================================================
