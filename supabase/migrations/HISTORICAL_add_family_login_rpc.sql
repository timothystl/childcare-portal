-- Server-side family login with attempt tracking and auto-lockout.
-- Called by the client via sbClient.rpc('family_login', ...) through the normal
-- proxied DB connection — avoids edge function proxy reliability issues.
--
-- Returns JSONB:
--   { error: 'not_found' | 'login_locked' | 'invalid_pin', attempts_left?: int }
--   { family: {...}, isParent2: bool }  on success

CREATE OR REPLACE FUNCTION public.family_login(p_email text, p_pin int)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_family   families%ROWTYPE;
    v_is_p2    boolean := false;
    v_exp_pin  int;
    v_attempts int;
    v_students jsonb;
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

    -- Verify PIN
    v_exp_pin := CASE WHEN v_is_p2 THEN v_family.parent2_pin ELSE v_family.pin END;

    IF p_pin IS DISTINCT FROM v_exp_pin THEN
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

    -- Success — reset counter
    UPDATE families SET login_attempts = 0 WHERE id = v_family.id;

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

-- Allow unauthenticated (anon) clients to call this function
GRANT EXECUTE ON FUNCTION public.family_login(text, int) TO anon;
