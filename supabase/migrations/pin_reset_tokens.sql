-- ============================================================
-- SELF-SERVICE PIN RESET
-- ============================================================
-- A parent who's forgotten their PIN can request a reset link by
-- email. Token is single-use, expires after 1 hour, and is bound to
-- a specific family + parent slot (parent 1 vs parent 2).
--
-- Flow:
--   1. Parent enters email on /calendar.
--   2. request-pin-reset Edge Function looks up the family, inserts
--      a row here with a 32-byte random token, and emails the link.
--   3. Parent clicks the link → /reset-pin.html?token=...
--   4. /reset-pin.html calls consume_pin_reset(token, new_pin),
--      which atomically validates the token, rotates pin_hash, and
--      marks the token used. Successful reset also clears any
--      existing login lockout.
-- ============================================================

CREATE TABLE IF NOT EXISTS pin_reset_tokens (
    token       text        PRIMARY KEY,
    family_id   uuid        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    is_parent2  boolean     NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz
);

CREATE INDEX IF NOT EXISTS pin_reset_tokens_family_idx
    ON pin_reset_tokens(family_id);

ALTER TABLE pin_reset_tokens ENABLE ROW LEVEL SECURITY;
-- No anon policies — tokens are written only by the request-pin-reset
-- Edge Function (service role) and read/written by the consume RPC,
-- which runs SECURITY DEFINER. Anon clients have no direct access.

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
BEGIN
    IF p_new_pin !~ '^\d{4,8}$' THEN
        RETURN jsonb_build_object('error', 'invalid_pin_format');
    END IF;

    SELECT * INTO v_row FROM pin_reset_tokens WHERE token = p_token FOR UPDATE;
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

    UPDATE pin_reset_tokens SET used_at = now() WHERE token = p_token;

    RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.consume_pin_reset(text, text) TO anon;

-- Periodic cleanup. Used or expired-for-7-days tokens have no value.
CREATE OR REPLACE FUNCTION public.cleanup_pin_reset_tokens()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    WITH deleted AS (
        DELETE FROM pin_reset_tokens
        WHERE expires_at < now() - interval '7 days'
           OR (used_at IS NOT NULL AND used_at < now() - interval '7 days')
        RETURNING 1
    )
    SELECT count(*)::int FROM deleted;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_pin_reset_tokens() TO authenticated;
