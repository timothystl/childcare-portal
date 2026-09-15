-- ============================================================
-- Fix geofence settings persistence (values not staying after reload)
-- ============================================================
-- Root cause: `geofence` is the first NEW key the admin app ever writes to
-- the `settings` table. Every other key (room_rates, offer_links, …) was
-- seeded long ago, so upsertSetting() only ever UPDATEs them — which works.
-- For a brand-new key it must INSERT, and that path broke because:
--   (a) `settings.key` had no UNIQUE constraint, so earlier onConflict upserts
--       silently inserted DUPLICATE rows (which then confuse reads); and/or
--   (b) RLS on `settings` permits authenticated SELECT/UPDATE but not INSERT,
--       so the write of a new key is silently dropped.
--
-- This script is idempotent and safe to run in the Supabase SQL Editor.
-- Run the whole thing top to bottom.
-- ============================================================

-- ---- STEP 0: SEE THE CURRENT STATE (read-only) ----
-- Run this first on its own if you want to inspect before changing anything.
SELECT ctid, key, value FROM settings WHERE key = 'geofence';


-- ---- STEP 1: DE-DUPLICATE every key (keep one row per key) ----
-- Keeps the physically-last row per key (ctid) and removes the rest.
-- ctid is universal, so this works no matter what columns the table has.
-- For `geofence` the exact survivor doesn't matter — you'll re-save from the UI.
DELETE FROM settings a
USING settings b
WHERE a.key = b.key
  AND a.ctid < b.ctid;


-- ---- STEP 2: ADD the missing UNIQUE constraint on key ----
-- Enables true atomic upserts and makes duplicate rows impossible going forward.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'settings_key_unique'
  ) THEN
    ALTER TABLE settings ADD CONSTRAINT settings_key_unique UNIQUE (key);
  END IF;
END $$;


-- ---- STEP 3: ENSURE admins can write new keys (idempotent RLS policy) ----
-- Harmless if RLS is disabled on settings (policies only apply when RLS is on).
-- If RLS is on and was blocking INSERT of new keys, this is the actual fix.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'settings' AND policyname = 'auth all settings'
  ) THEN
    CREATE POLICY "auth all settings"
      ON settings FOR ALL
      TO authenticated
      USING (true) WITH CHECK (true);
  END IF;
END $$;


-- ---- STEP 4: SEED a geofence row if none exists ----
-- Guarantees the row EXISTS, so upsertSetting() uses its proven UPDATE path
-- (the same path every working setting uses). Feature stays OFF until you
-- fill in the fields and click Save in the admin UI.
INSERT INTO settings (key, value)
SELECT 'geofence', '{"enabled": false}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'geofence');


-- ---- STEP 5: VERIFY (should return exactly ONE geofence row) ----
SELECT key, value FROM settings WHERE key = 'geofence';
