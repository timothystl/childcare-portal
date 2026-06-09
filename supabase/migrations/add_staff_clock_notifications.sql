-- Tracks missed-clock notifications already sent to prevent duplicates
CREATE TABLE IF NOT EXISTS staff_clock_notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id          uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  work_date         date NOT NULL,
  notification_type text NOT NULL,  -- 'missed_clock_in_am', 'missed_clock_in_pm', 'missed_clock_out'
  sent_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE(staff_id, work_date, notification_type)
);
