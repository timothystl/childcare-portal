-- ============================================================
-- Attempt-level logging for family & authorized-user PIN logins
-- ============================================================
-- pin_attempt_log already exists as a global/per-IP throttle window for
-- staff PIN attempts (verify_staff_pin -> record_pin_attempt). Family and
-- authorized-user logins only ever recorded a live counter on their own
-- row (families.login_attempts, family_authorized_users.login_attempts),
-- which is enough to THROTTLE but leaves no trail to look back on if a
-- brute-force is later suspected — no timestamps, no which-account, no
-- which-IP, and the counter itself resets to 0 on a successful login.
--
-- This does NOT add IP-based throttling to the family/authorized-user
-- path (pin_attempts_blocked stays staff-only) — that's a bigger behavior
-- change, out of scope for this pass. It only makes existing attempts
-- visible in the same log staff PINs already use, tagged by kind and which
-- account was targeted, so a later investigation isn't limited to "how
-- many failures right now."

ALTER TABLE public.pin_attempt_log
    ADD COLUMN IF NOT EXISTS kind       text NOT NULL DEFAULT 'staff',
    ADD COLUMN IF NOT EXISTS subject_id text;

COMMENT ON COLUMN public.pin_attempt_log.kind IS
    'Which login path this attempt came from: staff, family, or authorized_user.';
COMMENT ON COLUMN public.pin_attempt_log.subject_id IS
    'families.id or family_authorized_users.id targeted by this attempt, as text. NULL when no matching account was found at all (email/id did not exist).';

CREATE INDEX IF NOT EXISTS pin_attempt_log_subject_idx
    ON public.pin_attempt_log (kind, subject_id, attempted_at DESC)
    WHERE subject_id IS NOT NULL;

-- Existing 2-argument callers (verify_staff_pin) keep working unchanged —
-- the new trailing arguments default to the same 'staff' / NULL this table
-- already implied before it had the columns.
CREATE OR REPLACE FUNCTION public.record_pin_attempt(
    p_ip         text,
    p_ok         boolean,
    p_kind       text DEFAULT 'staff',
    p_subject_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    INSERT INTO pin_attempt_log (client_ip, succeeded, kind, subject_id)
    VALUES (p_ip, p_ok, p_kind, p_subject_id);
    -- Opportunistic prune rather than another cron job to forget about. The
    -- log is a rate-limit window plus a forensic trail, not permanent
    -- history; 24 hours is far more than the longest throttle window needs,
    -- and the new kind/subject_id columns don't change that retention call.
    IF random() < 0.01 THEN
        DELETE FROM pin_attempt_log WHERE attempted_at < now() - interval '24 hours';
    END IF;
END;
$$;

-- ------------------------------------------------------------
-- family_login — same body as ss2_family_login_text_pin.sql / the live
-- function, with record_pin_attempt() calls added at every return path.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.family_login(p_email text, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_cand      record;
    v_family    families%ROWTYPE;
    v_is_p2     boolean := false;
    v_hash      text;
    v_attempts  int;
    v_students  jsonb;
    v_found_any boolean := false;
    v_all_locked boolean := true;
    v_matched   boolean := false;
    v_ip        text;
BEGIN
    v_ip := pin_client_ip();

    IF p_pin IS NULL OR p_pin !~ '^\d{4,8}$' THEN
        RETURN jsonb_build_object('error', 'invalid_pin', 'attempts_left', 5);
    END IF;

    -- Slot 1 first so that when both slots share an address and both hashes
    -- somehow match, the result is the same identity as before this change.
    FOR v_cand IN
        SELECT f.id, 1 AS slot FROM families f WHERE lower(f.parent_email)  = lower(p_email)
        UNION ALL
        SELECT f.id, 2        FROM families f WHERE lower(f.parent2_email) = lower(p_email)
        ORDER BY slot
    LOOP
        v_found_any := true;
        SELECT * INTO v_family FROM families WHERE id = v_cand.id;

        IF v_family.login_locked THEN
            CONTINUE;                       -- a locked family is not a candidate
        END IF;
        v_all_locked := false;

        v_hash := CASE WHEN v_cand.slot = 2 THEN v_family.parent2_pin_hash ELSE v_family.pin_hash END;
        IF v_hash IS NOT NULL AND crypt(p_pin, v_hash) = v_hash THEN
            v_is_p2   := (v_cand.slot = 2);
            v_matched := true;
            EXIT;
        END IF;
    END LOOP;

    IF NOT v_found_any THEN
        PERFORM record_pin_attempt(v_ip, false, 'family', NULL);
        RETURN jsonb_build_object('error', 'not_found');
    END IF;
    IF v_all_locked THEN
        PERFORM record_pin_attempt(v_ip, false, 'family', v_family.id::text);
        RETURN jsonb_build_object('error', 'login_locked');
    END IF;

    IF NOT v_matched THEN
        -- Count the failure ONCE per family, not once per slot: a shared inbox
        -- must not burn through the lockout twice as fast as anyone else's.
        UPDATE families f
        SET login_attempts = COALESCE(f.login_attempts, 0) + 1,
            login_locked   = (COALESCE(f.login_attempts, 0) + 1 >= 5)
        WHERE (lower(f.parent_email) = lower(p_email) OR lower(f.parent2_email) = lower(p_email))
          AND f.login_locked = false;

        SELECT COALESCE(min(f.login_attempts), 5) INTO v_attempts
        FROM families f
        WHERE lower(f.parent_email) = lower(p_email) OR lower(f.parent2_email) = lower(p_email);

        PERFORM record_pin_attempt(v_ip, false, 'family', v_family.id::text);

        IF v_attempts >= 5 THEN
            RETURN jsonb_build_object('error', 'login_locked');
        END IF;
        RETURN jsonb_build_object('error', 'invalid_pin', 'attempts_left', 5 - v_attempts);
    END IF;

    UPDATE families SET login_attempts = 0 WHERE id = v_family.id;
    PERFORM record_pin_attempt(v_ip, true, 'family', v_family.id::text);

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
$function$;

-- ------------------------------------------------------------
-- authorized_user_login — same body as the live function, with
-- record_pin_attempt() calls added at every return path.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.authorized_user_login(p_email text, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_user      family_authorized_users%ROWTYPE;
    v_family    families%ROWTYPE;
    v_attempts  int;
    v_students  jsonb;
    v_pin_ok    boolean;
    v_ip        text;
BEGIN
    v_ip := pin_client_ip();

    IF p_pin IS NULL OR p_pin !~ '^\d{4,8}$' THEN
        RETURN jsonb_build_object('error', 'invalid_pin', 'attempts_left', 5);
    END IF;

    SELECT * INTO v_user FROM family_authorized_users
    WHERE lower(email) = lower(p_email) AND active;
    IF NOT FOUND THEN
        PERFORM record_pin_attempt(v_ip, false, 'authorized_user', NULL);
        RETURN jsonb_build_object('error', 'not_found');
    END IF;
    IF v_user.login_locked THEN
        PERFORM record_pin_attempt(v_ip, false, 'authorized_user', v_user.id::text);
        RETURN jsonb_build_object('error', 'login_locked');
    END IF;

    v_pin_ok := (v_user.pin_hash IS NOT NULL AND crypt(p_pin, v_user.pin_hash) = v_user.pin_hash);

    IF NOT v_pin_ok THEN
        v_attempts := COALESCE(v_user.login_attempts, 0) + 1;
        PERFORM record_pin_attempt(v_ip, false, 'authorized_user', v_user.id::text);
        IF v_attempts >= 5 THEN
            UPDATE family_authorized_users SET login_locked = true, login_attempts = v_attempts WHERE id = v_user.id;
            RETURN jsonb_build_object('error', 'login_locked');
        ELSE
            UPDATE family_authorized_users SET login_attempts = v_attempts WHERE id = v_user.id;
            RETURN jsonb_build_object('error', 'invalid_pin', 'attempts_left', 5 - v_attempts);
        END IF;
    END IF;

    UPDATE family_authorized_users SET login_attempts = 0 WHERE id = v_user.id;
    PERFORM record_pin_attempt(v_ip, true, 'authorized_user', v_user.id::text);

    SELECT * INTO v_family FROM families WHERE id = v_user.family_id;
    IF NOT FOUND OR v_family.login_locked THEN
        RETURN jsonb_build_object('error', 'login_locked');
    END IF;

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
        'authorizedUserId', v_user.id,
        'authorizedUserName', v_user.name);
END;
$function$;

-- ============================================================
-- VERIFY AFTER APPLYING
-- ============================================================
--   -- existing staff calls still work with only 2 args:
--   select record_pin_attempt('203.0.113.5'::text, true);
--   select kind, subject_id from pin_attempt_log order by attempted_at desc limit 1;
--   -- expect kind='staff', subject_id=null
--
--   -- a wrong family PIN now logs kind='family' with that family's id:
--   select family_login('someone@example.com', '0000');
--   select kind, subject_id, succeeded from pin_attempt_log order by attempted_at desc limit 1;
