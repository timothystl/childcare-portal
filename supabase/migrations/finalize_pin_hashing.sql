-- ============================================================
-- FINALIZE PIN HASHING
-- ============================================================
-- The plaintext `pin` and `parent2_pin` columns on `families` were
-- dropped in drop_plaintext_pins.sql. The RPC functions defined in
-- hash_family_pins.sql still referenced those columns (legacy fallback
-- path in family_login(), and the in-sync UPDATE in set_family_pin()),
-- which now raises "column families.pin does not exist" at runtime.
--
-- This migration:
--   1. Adds `has_pin` / `has_parent2_pin` generated boolean columns so
--      the admin UI can flag families missing a PIN without exposing
--      the bcrypt hashes to clients.
--   2. Replaces family_login() with a bcrypt-only version (no legacy
--      plaintext fallback).
--   3. Replaces set_family_pin() so it only writes to *_pin_hash.
-- ============================================================

-- 1. Generated "has PIN" booleans
ALTER TABLE families
    ADD COLUMN IF NOT EXISTS has_pin
        boolean GENERATED ALWAYS AS (pin_hash IS NOT NULL) STORED,
    ADD COLUMN IF NOT EXISTS has_parent2_pin
        boolean GENERATED ALWAYS AS (parent2_pin_hash IS NOT NULL) STORED;

-- 2. family_login() — bcrypt only
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
    v_attempts  int;
    v_students  jsonb;
    v_pin_ok    boolean;
BEGIN
    SELECT * INTO v_family
    FROM families
    WHERE lower(parent_email) = lower(p_email);

    IF NOT FOUND THEN
        SELECT * INTO v_family
        FROM families
        WHERE lower(parent2_email) = lower(p_email);
        v_is_p2 := true;
    END IF;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('error', 'not_found');
    END IF;

    IF v_family.login_locked THEN
        RETURN jsonb_build_object('error', 'login_locked');
    END IF;

    v_hash := CASE WHEN v_is_p2 THEN v_family.parent2_pin_hash ELSE v_family.pin_hash END;

    IF v_hash IS NULL THEN
        v_pin_ok := false;
    ELSE
        v_pin_ok := (crypt(p_pin::text, v_hash) = v_hash);
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

    UPDATE families SET login_attempts = 0 WHERE id = v_family.id;

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

-- 3. set_family_pin() — writes only to *_pin_hash
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
    IF p_new_pin !~ '^\d{4,8}$' THEN
        RAISE EXCEPTION 'PIN must be 4–8 digits';
    END IF;

    v_hash := crypt(p_new_pin, gen_salt('bf', 10));

    IF p_is_parent2 THEN
        UPDATE families SET parent2_pin_hash = v_hash WHERE id = p_family_id;
    ELSE
        UPDATE families SET pin_hash = v_hash WHERE id = p_family_id;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.family_login(text, int)             TO anon;
GRANT EXECUTE ON FUNCTION public.set_family_pin(uuid, text, boolean) TO authenticated;
