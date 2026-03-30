-- ============================================================
-- Staff schedule assignments (from auto-fill planner)
-- Each row = one staff member assigned to one room for one
-- shift (am/pm) on one date.
-- ============================================================

CREATE TABLE IF NOT EXISTS staff_schedules (
    id          BIGSERIAL    PRIMARY KEY,
    staff_id    BIGINT       NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    work_date   DATE         NOT NULL,
    room_id     TEXT         NOT NULL,
    shift       TEXT         NOT NULL CHECK (shift IN ('am', 'pm')),
    created_at  TIMESTAMPTZ  DEFAULT NOW(),
    UNIQUE (staff_id, work_date, shift)
    -- One staff member can only be scheduled in one room per shift per day.
    -- ON CONFLICT ignored at DB level; save logic deletes the week first.
);

-- Index for date-range queries (P&L report, schedule display)
CREATE INDEX IF NOT EXISTS idx_staff_schedules_work_date
    ON staff_schedules (work_date);

CREATE INDEX IF NOT EXISTS idx_staff_schedules_date_room
    ON staff_schedules (work_date, room_id);

-- RLS: admin-only (authenticated), same pattern as billing_summary
ALTER TABLE staff_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin select staff_schedules"
    ON staff_schedules FOR SELECT
    USING (auth.role() = 'authenticated');

CREATE POLICY "Admin insert staff_schedules"
    ON staff_schedules FOR INSERT
    WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Admin update staff_schedules"
    ON staff_schedules FOR UPDATE
    USING     (auth.role() = 'authenticated')
    WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Admin delete staff_schedules"
    ON staff_schedules FOR DELETE
    USING (auth.role() = 'authenticated');
