-- ============================================================
-- SS2 — Family PINs as TEXT end-to-end (fixes leading-zero lockout)
-- ============================================================
-- PINs are SET as text (set_family_pin validates ^\d{4,8}$ and bcrypt-hashes the
-- literal string), but family_login took p_pin INT and did crypt(p_pin::text,…).
-- So "0123" → 123 → never matches the hash of "0123" → 5 fails → lockout.
-- This recreates family_login with p_pin TEXT (only change vs. the current body:
-- the parameter type, a digit-format guard, and crypt(p_pin,…) instead of
-- crypt(p_pin::text,…)). DROP is required because the argument type changes.
--
-- ⚠️ SEQUENCING — apply this BEFORE deploying the matching JS/edge change:
--    1. Apply this migration (staging → prod).
--    2. Deploy the edge function:  supabase functions deploy family-lookup
--    3. Deploy the frontend (familyLogin sends the PIN as a string).
--    Do NOT deploy the JS first — sending a string to the old INT function can
--    be rejected by PostgREST.
--
-- NOTE: families whose PIN was migrated from the OLD plaintext INT column and
-- happened to start with 0 already lost the leading zero at migration time;
-- those few will still need a PIN reset. This fixes everyone going forward.
-- ============================================================

DROP FUNCTION IF EXISTS public.family_login(text, int);

CREATE OR REPLACE FUNCTION public.family_login(p_email text, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_family    families%ROWTYPE;
    v_is_p2     boolean := false;
    v_hash      text;
    v_attempts  int;
    v_students  jsonb;
    v_pin_ok    boolean;
BEGIN
    IF p_pin IS NULL OR p_pin !~ '^\d{4,8}$' THEN
        RETURN jsonb_build_object('error', 'invalid_pin', 'attempts_left', 5);
    END IF;

    SELECT * INTO v_family FROM families WHERE lower(parent_email) = lower(p_email);
    IF NOT FOUND THEN
        SELECT * INTO v_family FROM families WHERE lower(parent2_email) = lower(p_email);
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
        v_pin_ok := (crypt(p_pin, v_hash) = v_hash);
    END IF;

    IF NOT v_pin_ok THEN
        v_attempts := COALESCE(v_family.login_attempts, 0) + 1;
        IF v_attempts >= 5 THEN
            UPDATE families SET login_locked = true, login_attempts = v_attempts WHERE id = v_family.id;
            RETURN jsonb_build_object('error', 'login_locked');
        ELSE
            UPDATE families SET login_attempts = v_attempts WHERE id = v_family.id;
            RETURN jsonb_build_object('error', 'invalid_pin', 'attempts_left', 5 - v_attempts);
        END IF;
    END IF;

    UPDATE families SET login_attempts = 0 WHERE id = v_family.id;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', s.id, 'child_name', s.child_name, 'child_dob', s.child_dob,
        'room_override', s.room_override, 'discount_type', s.discount_type,
        'discount_value', s.discount_value, 'discount_note', s.discount_note,
        'recurring_days', s.recurring_days)), '[]'::jsonb)
    INTO v_students FROM students s WHERE s.family_id = v_family.id;

    RETURN jsonb_build_object(
        'family', jsonb_build_object(
            'id', v_family.id, 'parent_name', v_family.parent_name,
            'parent_email', v_family.parent_email, 'parent_phone', v_family.parent_phone,
            'parent2_name', v_family.parent2_name, 'parent2_email', v_family.parent2_email,
            'parent2_phone', v_family.parent2_phone,
            'registration_locked', v_family.registration_locked,
            'login_locked', v_family.login_locked, 'students', v_students),
        'isParent2', v_is_p2);
END;
$$;

GRANT EXECUTE ON FUNCTION public.family_login(text, text) TO anon;
