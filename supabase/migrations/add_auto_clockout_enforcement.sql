-- ============================================================
-- AUTO CLOCK-OUT ENFORCEMENT
-- Adds:
--   1. clock_out_method column on staff_clock_events
--   2. staff_schedule_times  — per-staff, per-date shift times
--   3. auto_clockout_log     — compliance audit trail
-- ============================================================

-- ── 1. Clock-out method tracking ─────────────────────────────
--   NULL  = existing rows (treated as 'manual')
--   'manual'               — staff pressed the button
--   'auto_lunch'           — system enforced lunch punch
--   'auto_end_of_shift'    — system enforced end-of-shift punch
--   'auto_hard_cutoff'     — 5 pm hard close of all open punches

ALTER TABLE staff_clock_events
    ADD COLUMN IF NOT EXISTS clock_out_method TEXT
        CHECK (clock_out_method IN ('manual','auto_lunch','auto_end_of_shift','auto_hard_cutoff'));

-- ── 2. Staff schedule times ───────────────────────────────────
-- One row per staff per work date.
-- The auto-clockout job reads these to know when each person
-- was supposed to punch out for lunch / end of shift.
-- lunch_out / lunch_in are nullable — null means no lunch break.

CREATE TABLE IF NOT EXISTS staff_schedule_times (
    id              BIGSERIAL       PRIMARY KEY,
    staff_id        UUID            NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    work_date       DATE            NOT NULL,
    scheduled_start TIME,                          -- expected clock-in (informational)
    lunch_out       TIME,                          -- expected lunch clock-out; NULL = no break
    lunch_in        TIME,                          -- expected return from lunch; NULL = no break
    scheduled_end   TIME            NOT NULL,      -- expected end-of-shift clock-out
    notes           TEXT,
    created_at      TIMESTAMPTZ     DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     DEFAULT NOW(),
    UNIQUE (staff_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_sst_work_date  ON staff_schedule_times (work_date);
CREATE INDEX IF NOT EXISTS idx_sst_staff_date ON staff_schedule_times (staff_id, work_date);

ALTER TABLE staff_schedule_times ENABLE ROW LEVEL SECURITY;

-- Authenticated admins can do everything
CREATE POLICY "Admin all staff_schedule_times"
    ON staff_schedule_times FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- Service role (edge functions) can also read/write via bypass_rls
-- No anon policy needed — only the edge function and admin portal access this table.

-- Trigger: keep updated_at current
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS sst_updated_at ON staff_schedule_times;
CREATE TRIGGER sst_updated_at
    BEFORE UPDATE ON staff_schedule_times
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ── 3. Auto clock-out compliance log ─────────────────────────
-- Every auto-clockout writes a row here for the permanent audit trail.
-- The edge function checks this table to prevent double-firing.

CREATE TABLE IF NOT EXISTS auto_clockout_log (
    id              BIGSERIAL       PRIMARY KEY,
    created_at      TIMESTAMPTZ     DEFAULT NOW(),
    work_date       DATE            NOT NULL,
    staff_id        UUID            NOT NULL REFERENCES staff(id) ON DELETE SET NULL,
    staff_name      TEXT            NOT NULL,      -- denormalized snapshot
    clock_event_id  BIGINT,                        -- FK to staff_clock_events.id (may be NULL if event deleted)
    trigger_type    TEXT            NOT NULL
        CHECK (trigger_type IN ('auto_lunch','auto_end_of_shift','auto_hard_cutoff')),
    scheduled_time  TEXT,                          -- e.g. '12:00' — the time they missed
    actual_clock_out TIMESTAMPTZ    NOT NULL,      -- UTC timestamp when auto-clockout fired
    alert_sent      BOOLEAN         NOT NULL DEFAULT false,
    alert_sent_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_acl_work_date  ON auto_clockout_log (work_date);
CREATE INDEX IF NOT EXISTS idx_acl_staff_date ON auto_clockout_log (staff_id, work_date);
CREATE INDEX IF NOT EXISTS idx_acl_trigger    ON auto_clockout_log (staff_id, work_date, trigger_type);

ALTER TABLE auto_clockout_log ENABLE ROW LEVEL SECURITY;

-- Admins can read the audit log
CREATE POLICY "Admin read auto_clockout_log"
    ON auto_clockout_log FOR SELECT
    TO authenticated
    USING (true);

-- Service-role edge function inserts via bypass_rls — no anon policy needed.

-- ── 4. Settings seed: geofence & shift defaults ───────────────
-- These are safe to INSERT OR IGNORE — admin updates via the Settings UI.

INSERT INTO settings (key, value) VALUES
(
    'geofence',
    '{
        "enabled": false,
        "lat": 38.6532,
        "lng": -90.3142,
        "radius_meters": 200
    }'::jsonb
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
(
    'director_email',
    '"director@example.com"'::jsonb
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
(
    'shift_defaults',
    '{
        "am":   { "start": "07:30", "lunch_out": "12:00", "lunch_in": "13:00", "end": "12:30" },
        "pm":   { "start": "12:00", "lunch_out": null,    "lunch_in": null,    "end": "18:00" },
        "full": { "start": "07:30", "lunch_out": "12:00", "lunch_in": "13:00", "end": "18:00" }
    }'::jsonb
)
ON CONFLICT (key) DO NOTHING;
