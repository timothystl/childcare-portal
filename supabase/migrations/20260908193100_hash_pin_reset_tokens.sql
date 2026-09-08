-- ============================================================
-- Hash PIN-reset tokens at rest
-- ============================================================
-- pin_reset_tokens.token was a 32-byte random value compared with plain
-- `=`, so it sat in the database in cleartext for up to an hour. Every
-- other bearer credential in this schema (family/authorized-user/staff
-- PINs) is bcrypt hashed; a reset token is a real bearer credential too
-- for the hour it's valid — whoever holds it can set a new PIN and clears
-- any existing lockout in the same call. Bringing it in line: store a
-- SHA-256 digest, never the raw token.
--
-- SHA-256 rather than bcrypt is deliberate: the token is already 256 bits
-- of CSPRNG output, not a human-guessable secret, so there's nothing for a
-- slow, salted hash to protect against that a fast digest doesn't already
-- rule out. A fast digest also keeps consume_pin_reset() cheap under its
-- SELECT ... FOR UPDATE lock.
--
-- ⚠️ DEPLOY THIS MIGRATION AND THE request-pin-reset EDGE FUNCTION UPDATE
-- TOGETHER. Any reset link issued by the old function in the window before
-- cutover stores a raw token that the new consume_pin_reset will no longer
-- match against token_hash — the parent gets 'invalid_token' and has to
-- request a new link, which is self-service and only a 1-hour-TTL
-- inconvenience. At review time there were zero outstanding unused tokens.

ALTER TABLE public.pin_reset_tokens RENAME COLUMN token TO token_hash;

COMMENT ON COLUMN public.pin_reset_tokens.token_hash IS
    'SHA-256 hex digest of the raw reset token. The raw token itself is never stored — only emailed to the parent once, at issue time, by request-pin-reset.';

CREATE OR REPLACE FUNCTION public.consume_pin_reset(
    p_token   text,
    p_new_pin text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_row  pin_reset_tokens%ROWTYPE;
    v_hash text;
    v_hex  text;
BEGIN
    IF p_new_pin !~ '^\d{4,8}$' THEN
        RETURN jsonb_build_object('error', 'invalid_pin_format');
    END IF;

    v_hex := encode(digest(p_token, 'sha256'), 'hex');

    SELECT * INTO v_row FROM pin_reset_tokens WHERE token_hash = v_hex FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('error', 'invalid_token');
    END IF;

    IF v_row.used_at IS NOT NULL THEN
        RETURN jsonb_build_object('error', 'token_already_used');
    END IF;

    IF v_row.expires_at < now() THEN
        RETURN jsonb_build_object('error', 'token_expired');
    END IF;

    v_hash := crypt(p_new_pin, gen_salt('bf', 10));

    IF v_row.is_parent2 THEN
        UPDATE families
        SET parent2_pin_hash = v_hash,
            login_locked     = false,
            login_attempts   = 0
        WHERE id = v_row.family_id;
    ELSE
        UPDATE families
        SET pin_hash       = v_hash,
            login_locked   = false,
            login_attempts = 0
        WHERE id = v_row.family_id;
    END IF;

    UPDATE pin_reset_tokens SET used_at = now() WHERE token_hash = v_hex;

    RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.consume_pin_reset(text, text) TO anon;

-- ============================================================
-- VERIFY AFTER APPLYING (deploy edge function first, this migration second,
-- or as close together as the deploy pipeline allows)
-- ============================================================
--   select token_hash from pin_reset_tokens limit 1;
--   -- expect a 64-char hex string, not a base64url token
--
--   -- request a reset link end-to-end, then:
--   select used_at from pin_reset_tokens where token_hash =
--     encode(digest('<token from the emailed link>', 'sha256'), 'hex');
--   -- before clicking: used_at is null; after consume_pin_reset succeeds: set
