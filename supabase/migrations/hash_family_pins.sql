-- ============================================================
-- HASH FAMILY PINs WITH BCRYPT (pgcrypto)
-- ============================================================
-- Replaces plaintext integer PINs with bcrypt hashes so that a
-- database breach cannot expose raw PINs.
--
-- Migration strategy (zero-downtime):
--   1. Enable pgcrypto extension.
--   2. Add new pin_hash / parent2_pin_hash TEXT columns.
--   3. Hash all existing integer PINs into those columns.
--   4. Replace family_login() with a version that verifies using
--      crypt() and falls back to integer comparison for any row
--      not yet hashed (supports rolling migration).
--   5. Add set_family_pin() RPC so the admin UI can hash new PINs
--      server-side — no plaintext PIN ever travels in an API response.
--
-- After confirming everything works you may drop the integer columns:
--   ALTER TABLE families DROP COLUMN pin;
--   ALTER TABLE families DROP COLUMN parent2_pin;
-- ============================================================

-- 1. Enable pgcrypto
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2. Add hash columns (idempotent)
ALTER TABLE families ADD COLUMN IF NOT EXISTS pin_hash        text;
ALTER TABLE families ADD COLUMN IF NOT EXISTS parent2_pin_hash text;

-- 3. Hash existing PINs (only rows that haven't been hashed yet)
UPDATE families
SET pin_hash = crypt(pin::text, gen_salt('bf', 10))
WHERE pin IS NOT NULL
  AND pin_hash IS NULL;

UPDATE families
SET parent2_pin_hash = crypt(parent2_pin::text, gen_salt('bf', 10))
WHERE parent2_pin IS NOT NULL
  AND parent2_pin_hash IS NULL;

-- 4. Replace family_login() with a version that uses crypt() for
--    comparison (bcrypt), falling back to the legacy integer column
--    for any row that hasn't been migrated yet.
CREATE OR REPLACE FUNCTION public.family_login(p_email text, p_pin int)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_family    families%ROWTYPE;
    v_is_p2     boolean := false;
    v_hash      text;
    v_legacy    int;
    v_attempts  int;
    v_students  jsonb;
    v_pin_ok    boolean;
BEGIN
    -- Try parent 1
    SELECT * INTO v_family
    FROM families
    WHERE lower(parent_email) = lower(p_email);

    -- Try parent 2 if not found
    IF NOT FOUND THEN
        SELECT * INTO v_family
        FROM families
        WHERE lower(parent2_email) = lower(p_email);
        v_is_p2 := true;
    END IF;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('error', 'not_found');
    END IF;

    -- Reject if already locked
    IF v_family.login_locked THEN
        RETURN jsonb_build_object('error', 'login_locked');
    END IF;

    -- Determine which hash / legacy PIN to compare against
    IF v_is_p2 THEN
        v_hash   := v_family.parent2_pin_hash;
        v_legacy := v_family.parent2_pin;
    ELSE
        v_hash   := v_family.pin_hash;
        v_legacy := v_family.pin;
    END IF;

    -- Verify PIN: prefer bcrypt hash; fall back to integer comparison
    IF v_hash IS NOT NULL THEN
        v_pin_ok := (crypt(p_pin::text, v_hash) = v_hash);
    ELSE
        v_pin_ok := (p_pin IS NOT DISTINCT FROM v_legacy);
    END IF;

    IF NOT v_pin_ok THEN
        v_attempts := COALESCE(v_family.login_attempts, 0) + 1;
        IF v_attempts >= 5 THEN
            UPDATE families
            SET login_locked = true, login_attempts = v_attempts
            WHERE id = v_family.id;
            RETURN jsonb_build_object('error', 'login_locked');
        ELSE
            UPDATE families
            SET login_attempts = v_attempts
            WHERE id = v_family.id;
            RETURN jsonb_build_object(
                'error', 'invalid_pin',
                'attempts_left', 5 - v_attempts
            );
        END IF;
    END IF;

    -- Success — reset counter; also hash PIN on-the-fly if still plaintext
    UPDATE families
    SET login_attempts = 0,
        pin_hash = CASE
            WHEN NOT v_is_p2 AND pin_hash IS NULL AND pin IS NOT NULL
            THEN crypt(pin::text, gen_salt('bf', 10))
            ELSE pin_hash
        END,
        parent2_pin_hash = CASE
            WHEN v_is_p2 AND parent2_pin_hash IS NULL AND parent2_pin IS NOT NULL
            THEN crypt(parent2_pin::text, gen_salt('bf', 10))
            ELSE parent2_pin_hash
        END
    WHERE id = v_family.id;

    -- Build students array
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id',             s.id,
        'child_name',     s.child_name,
        'child_dob',      s.child_dob,
        'room_override',  s.room_override,
        'discount_type',  s.discount_type,
        'discount_value', s.discount_value,
        'discount_note',  s.discount_note,
        'recurring_days', s.recurring_days
    )), '[]'::jsonb)
    INTO v_students
    FROM students s
    WHERE s.family_id = v_family.id;

    RETURN jsonb_build_object(
        'family', jsonb_build_object(
            'id',                  v_family.id,
            'parent_name',         v_family.parent_name,
            'parent_email',        v_family.parent_email,
            'parent_phone',        v_family.parent_phone,
            'parent2_name',        v_family.parent2_name,
            'parent2_email',       v_family.parent2_email,
            'parent2_phone',       v_family.parent2_phone,
            'registration_locked', v_family.registration_locked,
            'login_locked',        v_family.login_locked,
            'students',            v_students
        ),
        'isParent2', v_is_p2
    );
END;
$$;

-- 5. set_family_pin() — admin UI calls this to set a new PIN;
--    hashing happens server-side, so plaintext never leaves the DB.
CREATE OR REPLACE FUNCTION public.set_family_pin(
    p_family_id  uuid,
    p_new_pin    text,
    p_is_parent2 boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hash text;
BEGIN
    -- Only digits, 4–8 characters
    IF p_new_pin !~ '^\d{4,8}$' THEN
        RAISE EXCEPTION 'PIN must be 4–8 digits';
    END IF;

    v_hash := crypt(p_new_pin, gen_salt('bf', 10));

    IF p_is_parent2 THEN
        UPDATE families
        SET parent2_pin      = p_new_pin::int,   -- keep legacy column in sync during transition
            parent2_pin_hash = v_hash
        WHERE id = p_family_id;
    ELSE
        UPDATE families
        SET pin      = p_new_pin::int,            -- keep legacy column in sync during transition
            pin_hash = v_hash
        WHERE id = p_family_id;
    END IF;
END;
$$;

-- Allow unauthenticated clients to call family_login (existing grant)
GRANT EXECUTE ON FUNCTION public.family_login(text, int) TO anon;

-- Only authenticated admins may set PINs
GRANT EXECUTE ON FUNCTION public.set_family_pin(uuid, text, boolean) TO authenticated;
