-- ============================================================
-- HASH STAFF PINs WITH BCRYPT (pgcrypto)
-- ============================================================
-- Staff clock-in PINs were stored as plaintext integers.
-- This migration:
--   1. Adds staff_pin_hash TEXT column + has_staff_pin generated boolean.
--   2. Hashes all existing PINs in-place using bcrypt (cost 10).
--   3. Clears the plaintext staff_pin values after hashing.
--   4. Creates lookup_staff_by_pin() RPC for the kiosk (anon-accessible).
--   5. Creates set_staff_pin() RPC for admin use (authenticated only).
--
-- After running, deploy updated clockin.html and supabase.js.
-- The plaintext staff_pin column is retained (nullable) for now and
-- can be dropped in a follow-up migration once everything is verified.
-- ============================================================

-- pgcrypto is already enabled from hash_family_pins migration,
-- but include it here to make this migration self-contained.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. New columns
ALTER TABLE staff
    ADD COLUMN IF NOT EXISTS staff_pin_hash TEXT,
    ADD COLUMN IF NOT EXISTS has_staff_pin
        boolean GENERATED ALWAYS AS (staff_pin_hash IS NOT NULL) STORED;

-- 2. Hash existing PINs
UPDATE staff
SET staff_pin_hash = crypt(staff_pin::text, gen_salt('bf', 10))
WHERE staff_pin IS NOT NULL
  AND staff_pin_hash IS NULL;

-- 3. Clear plaintext now that hashes are set
UPDATE staff SET staff_pin = NULL WHERE staff_pin_hash IS NOT NULL;

-- 4. RPC: look up an active staff member by PIN (used by clock-in kiosk)
--    Scans all active staff with a hash and bcrypt-compares each one.
--    Acceptable for small rosters (~20 staff × ~100 ms = <2 s worst case).
CREATE OR REPLACE FUNCTION public.lookup_staff_by_pin(p_pin int)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_staff staff%ROWTYPE;
BEGIN
    SELECT s.*
    INTO v_staff
    FROM staff s
    WHERE s.active = true
      AND s.staff_pin_hash IS NOT NULL
      AND crypt(p_pin::text, s.staff_pin_hash) = s.staff_pin_hash
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    RETURN jsonb_build_object(
        'id',       v_staff.id,
        'name',     v_staff.name,
        'role',     v_staff.role,
        'room_id',  v_staff.room_id,
        'pay_type', v_staff.pay_type
    );
END;
$$;

-- 5. RPC: set (or change) a staff member's PIN — called by admin UI
CREATE OR REPLACE FUNCTION public.set_staff_pin(p_staff_id uuid, p_new_pin int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
    UPDATE staff
    SET staff_pin_hash = crypt(p_new_pin::text, gen_salt('bf', 10)),
        staff_pin = NULL
    WHERE id = p_staff_id;
END;
$$;

-- Grants: kiosk uses anon key; admin PIN changes require an auth session
GRANT EXECUTE ON FUNCTION public.lookup_staff_by_pin(int) TO anon;
GRANT EXECUTE ON FUNCTION public.set_staff_pin(uuid, int) TO authenticated;
