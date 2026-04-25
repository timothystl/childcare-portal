-- Drop plaintext PIN columns now that all rows have been migrated to bcrypt.
-- Pre-condition: pin_hash IS NOT NULL for every row in families
--   (verified: SELECT COUNT(*) FROM families WHERE pin_hash IS NULL → 0)
-- Pre-condition: parent2_pin_hash IS NOT NULL for every row that had a parent2_pin
--   (verified: SELECT COUNT(*) FROM families WHERE parent2_pin IS NOT NULL AND parent2_pin_hash IS NULL → 0)
-- Applied to production: 2026-04-25

ALTER TABLE families DROP COLUMN IF EXISTS pin;
ALTER TABLE families DROP COLUMN IF EXISTS parent2_pin;
