-- ============================================================
-- Historical Attendance & Billing Summary Tables
-- For back-dated data (Jan–Apr 2026) imported from spreadsheet
-- ============================================================

-- Daily room-level attendance counts
-- (no per-child breakdown available for this period)
CREATE TABLE IF NOT EXISTS attendance_summary (
    id              BIGSERIAL PRIMARY KEY,
    summary_date    DATE        NOT NULL,
    room_id         TEXT        NOT NULL,
    half_days       INTEGER,          -- NULL if no half/full split in source
    full_days       INTEGER,          -- NULL if no half/full split in source
    total_attended  INTEGER     NOT NULL,
    data_source     TEXT        DEFAULT 'spreadsheet_import',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (summary_date, room_id)
);

-- Monthly billing totals per room
CREATE TABLE IF NOT EXISTS billing_summary (
    id          BIGSERIAL PRIMARY KEY,
    month       DATE        NOT NULL,   -- first day of month (e.g. 2026-01-01)
    room_id     TEXT        NOT NULL,
    half_days   INTEGER,
    full_days   INTEGER,
    subtotal    NUMERIC(10,2),          -- before discounts (NULL if not available)
    discount    NUMERIC(10,2),          -- NULL if not available
    net_billed  NUMERIC(10,2)   NOT NULL,
    data_source TEXT        DEFAULT 'spreadsheet_import',
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (month, room_id)
);

-- Allow authenticated admin reads; no anonymous access
ALTER TABLE attendance_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_summary    ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin read attendance_summary"
    ON attendance_summary FOR SELECT
    USING (auth.role() = 'authenticated');

CREATE POLICY "Admin insert attendance_summary"
    ON attendance_summary FOR INSERT
    WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Admin read billing_summary"
    ON billing_summary FOR SELECT
    USING (auth.role() = 'authenticated');

CREATE POLICY "Admin insert billing_summary"
    ON billing_summary FOR INSERT
    WITH CHECK (auth.role() = 'authenticated');
