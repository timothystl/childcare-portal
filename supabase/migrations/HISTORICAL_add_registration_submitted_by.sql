-- ============================================================
-- Add submitted_by column to registrations
-- Tracks who entered the care calendar: parent1, parent2, admin
-- ============================================================

ALTER TABLE registrations
    ADD COLUMN IF NOT EXISTS submitted_by text DEFAULT 'parent1';

COMMENT ON COLUMN registrations.submitted_by IS
    'Who submitted this registration: ''parent1'', ''parent2'', or ''admin''';
