-- ============================================================
-- Child attendance capture (booked vs. actually attended).
-- APPLIED IN PRODUCTION 2026-08-11.
--
-- Post-apply verification (all passed):
--   * anon holds zero grants; RLS enabled; the only policy is scoped to
--     `authenticated`. Smoke-tested `set local role anon; select ... ` →
--     permission denied.
--   * upsert on (registration_id, care_date) reuses the existing row and
--     flips its status rather than inserting a duplicate.
--   * the verification row was deleted; the table is empty.
--
-- Until now the portal recorded which days a child was BOOKED for
-- (registration_dates) and when STAFF clocked in (staff_clock_events), but
-- nothing anywhere recorded whether a child actually showed up. Every report
-- that says "attendance" is really reporting bookings, and no-show rates,
-- cancellation behaviour and any honest demand forecast are unfittable
-- without this.
--
-- One row per child per care date. registration_id identifies the child-month
-- registration; care_date pins the day. The unique constraint makes the write
-- path a clean upsert and stops a double-tap creating two conflicting marks.
--
-- SECURITY NOTE — this table says which named children were physically
-- present on a given day, so it must never be readable with the public anon
-- key. Supabase's default grants hand `anon` full table privileges (this is
-- how R26/R27 happened), and RLS is the only thing standing in the way. We do
-- both: revoke the grants explicitly AND scope the policy to `authenticated`.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.attendance_records (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    registration_id bigint NOT NULL REFERENCES public.registrations(id) ON DELETE CASCADE,
    care_date       date   NOT NULL,
    -- Denormalised so historical rows survive a room move or a rename; the
    -- registration remains the source of truth for the current values.
    room_id         text,
    child_name      text,
    status          text   NOT NULL CHECK (status IN ('present', 'absent')),
    recorded_by     text,
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT attendance_records_child_date_unique UNIQUE (registration_id, care_date)
);

-- Reports read by date range; the forecast reads a rolling window.
CREATE INDEX IF NOT EXISTS attendance_records_care_date_idx
    ON public.attendance_records (care_date);
CREATE INDEX IF NOT EXISTS attendance_records_room_date_idx
    ON public.attendance_records (room_id, care_date);

ALTER TABLE public.attendance_records ENABLE ROW LEVEL SECURITY;

-- Strip the Supabase defaults before granting anything back.
REVOKE ALL ON public.attendance_records FROM anon;
REVOKE ALL ON public.attendance_records FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.attendance_records TO authenticated;

-- No policy exists for `anon`, so even if a future default-privilege change
-- re-grants the table, RLS still denies every anon row.
DROP POLICY IF EXISTS admin_all_attendance_records ON public.attendance_records;
CREATE POLICY admin_all_attendance_records
    ON public.attendance_records
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);
