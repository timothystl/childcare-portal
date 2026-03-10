-- Add login lockout fields to families table
-- login_locked: admin-resettable flag; set automatically after 5 failed PIN attempts
-- login_attempts: rolling count of consecutive failed attempts (reset on success or admin unlock)

ALTER TABLE families
    ADD COLUMN IF NOT EXISTS login_locked   BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS login_attempts INT     DEFAULT 0;
