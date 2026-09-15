-- ============================================================
-- Clock-in integrity: record the device, and stop lying about location
-- ============================================================
-- Asked for on 2026-08-14: "can we tie their login to their device so staff
-- can't log each other in?" The decision was to MEASURE FIRST — record enough
-- to find out whether it is happening, without blocking anyone at 7am. Nothing
-- in this migration refuses a punch. It only makes the record honest.
--
-- ⚠️ THE GEOFENCE HAS NEVER ONCE WORKED, AND FAILED SILENTLY.
-- `geofence` is enabled in settings (300ft, alerts to mdo@) and clockin.html
-- does call getCurrentPosition. Yet ALL 1,547 clock events since 2026-03-04
-- carry a NULL lat/lon and `clock_in_outside_fence = false`. Two causes, both
-- fixed here and in clockin.html:
--
--   1. The error callback resolved `outsideFence: false`. A denied location
--      permission was therefore STORED AS "inside the fence" — the one value
--      that means "we checked and they were here."
--   2. Both fence columns carry DEFAULT false, so even omitting the column
--      lands on the same lie.
--
-- The honest value for "we do not know" is NULL, and the reason we do not know
-- is worth keeping, so `*_location_status` records which it was.

-- ── Device identity ─────────────────────────────────────────
-- A random UUID minted once per browser and kept in localStorage. NOT a
-- hardware fingerprint: no canvas, no user-agent hashing, nothing that follows
-- the person off this origin. It rides along on clock punches and nowhere else.
--
-- ⚠️ WHAT THIS CAN AND CANNOT PROVE. Clearing site data mints a new id, so
-- "these two punches came from one device" is EVIDENCE, while "these came from
-- different devices" is NOT. That asymmetry is the right way round for
-- detection — we are looking for collisions, and a rotated id is only noise.
-- Do not build an access-control decision on this column; it is a report.
--
-- Clock-out gets its own column because clocking out from a different phone
-- than you clocked in on is itself worth seeing.
ALTER TABLE public.staff_clock_events
    ADD COLUMN IF NOT EXISTS clock_in_device_id       text,
    ADD COLUMN IF NOT EXISTS clock_out_device_id      text,
    ADD COLUMN IF NOT EXISTS clock_in_location_status text,
    ADD COLUMN IF NOT EXISTS clock_out_location_status text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clock_in_location_status_ck') THEN
        ALTER TABLE public.staff_clock_events
            ADD CONSTRAINT clock_in_location_status_ck CHECK (
                clock_in_location_status IS NULL OR clock_in_location_status IN
                ('ok','denied','unavailable','timeout','unsupported','off','not_recorded'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clock_out_location_status_ck') THEN
        ALTER TABLE public.staff_clock_events
            ADD CONSTRAINT clock_out_location_status_ck CHECK (
                clock_out_location_status IS NULL OR clock_out_location_status IN
                ('ok','denied','unavailable','timeout','unsupported','off','not_recorded'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS staff_clock_device_idx
    ON public.staff_clock_events (clock_in_device_id, work_date DESC)
    WHERE clock_in_device_id IS NOT NULL;

-- ── Stop defaulting to a claim we cannot support ────────────
ALTER TABLE public.staff_clock_events ALTER COLUMN clock_in_outside_fence  DROP DEFAULT;
ALTER TABLE public.staff_clock_events ALTER COLUMN clock_out_outside_fence DROP DEFAULT;

-- ── Make the existing 1,547 rows tell the truth ─────────────
-- Every one of them says "inside the fence" on the strength of no coordinate at
-- all. Left alone they would poison the very report this migration exists to
-- produce: a location-coverage number computed over them reads 100% compliant.
-- 'not_recorded' distinguishes "predates this change" from a real denial, so
-- the report can say "we started measuring on 2026-08-14" rather than implying
-- every staff member refused.
UPDATE public.staff_clock_events
   SET clock_in_outside_fence  = NULL,
       clock_in_location_status = 'not_recorded'
 WHERE clock_in_lat IS NULL AND clock_in_location_status IS NULL;

UPDATE public.staff_clock_events
   SET clock_out_outside_fence  = NULL,
       clock_out_location_status = 'not_recorded'
 WHERE clock_out IS NOT NULL AND clock_out_lat IS NULL AND clock_out_location_status IS NULL;

-- ── Grants ──────────────────────────────────────────────────
-- ⚠️ THIS TABLE'S GRANTS ARE PER-COLUMN, NOT TABLE-WIDE. A new column is NOT
-- covered by the existing grant, so the kiosk would fail on the first punch
-- with `permission denied for column` if this block were skipped. Checked with
-- information_schema.column_privileges rather than assumed.
GRANT INSERT (clock_in_device_id, clock_out_device_id,
              clock_in_location_status, clock_out_location_status)
    ON public.staff_clock_events TO anon, authenticated;
GRANT UPDATE (clock_in_device_id, clock_out_device_id,
              clock_in_location_status, clock_out_location_status)
    ON public.staff_clock_events TO anon, authenticated;

-- SELECT goes to `authenticated` ONLY. The director's report reads these; the
-- clock-in page never does — it writes them and moves on. anon already reads
-- more of this table than it should (R1/R4 remainder), and there is no reason
-- to widen that with a column that maps a staff member to their phone.
GRANT SELECT (clock_in_device_id, clock_out_device_id,
              clock_in_location_status, clock_out_location_status)
    ON public.staff_clock_events TO authenticated;

-- ⚠️ Both clock write paths in clockin.html are BARE .insert() / .update()
-- with no chained .select(), so no RETURNING is produced and anon needs no
-- SELECT on these columns. Verified before choosing the grant above — this is
-- the trap documented in CLAUDE.md that took registration down for six hours.
