-- ============================================================
-- Additional trusted party — a handful of families need a third
-- person (beyond parent 1 / parent 2) who can log into the parent
-- portal and see the same child info and billing/payments a parent
-- sees. This is NOT `pickup_contacts` (name/relationship/note only,
-- no login, family self-service) — this person gets a real portal
-- session.
-- ============================================================
-- DESIGN CHOICE: this does NOT touch family_login(), the most
-- security-hardened function in this schema (SS11/SS16/SX13 all live
-- there). `families`/`parent_accounts.parent_slot` are hard-coded to
-- exactly two parent slots throughout (family_login's two branches,
-- parent_slot's CHECK, my_parent_context()'s CASE) — widening that in
-- place would touch the primary login path for every family. Instead
-- this adds a wholly separate table + a separate, parallel login RPC.
-- The one integration point is parent_accounts, which already carries
-- everything RLS needs: parent_owns_student() and every billing/
-- schedule RPC key off parent_family_ids()/my_parent_context()->>
-- 'family_id', not off which parent slot logged in — so a row in
-- parent_accounts with the right family_id gets full parent-portal
-- access automatically, with zero changes to any of that.
--
-- The office (`parent-session` edge function) tries family_login()
-- first; only on 'not_found' — the email isn't a registered parent —
-- does it try authorized_user_login(). A real parent's email always
-- resolves as a parent.
-- ============================================================

CREATE TABLE public.family_authorized_users (
    id             bigserial PRIMARY KEY,
    family_id      uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
    name           text NOT NULL,
    email          text NOT NULL,
    relationship   text,
    pin_hash       text,
    active         boolean NOT NULL DEFAULT true,
    login_locked   boolean NOT NULL DEFAULT false,
    login_attempts integer NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX family_authorized_users_family_idx ON public.family_authorized_users (family_id);
-- One login identity per email, same invariant parent_accounts already
-- enforces for parents (parent_accounts_email_key) — a duplicate here
-- would make login resolution depend on insertion order, which is not
-- something an admin adding a second row later should be able to do
-- silently.
CREATE UNIQUE INDEX family_authorized_users_email_key ON public.family_authorized_users (lower(email));

ALTER TABLE public.family_authorized_users ENABLE ROW LEVEL SECURITY;

-- Defense in depth only — every real access path below is a SECURITY
-- DEFINER RPC, not a direct table grant, specifically so pin_hash is
-- never selectable by anyone. RLS still gets an explicit policy (never
-- "enabled with no policy, trust the grants") and the grants are
-- revoked outright, per this file's own SX1/NEW-1 lesson about a new
-- table quietly keeping Supabase's default anon/authenticated grants.
CREATE POLICY "admin all family_authorized_users" ON public.family_authorized_users
    FOR ALL TO authenticated
    USING (admin_role() IN ('full', 'restricted'))
    WITH CHECK (admin_role() IN ('full', 'restricted'));

REVOKE ALL ON public.family_authorized_users FROM anon, PUBLIC;

-- ------------------------------------------------------------
-- Admin management RPCs. Gated the same as the Family Directory's own
-- PII (FS14: restricted already sees full family PII/PINs/discounts),
-- and using the COALESCE(admin_role(), '') idiom throughout — a plain
-- `admin_role() NOT IN (...)` is NULL, not true, for a non-admin caller
-- and would silently fail to deny (this file's own 2026-09-02 and
-- 2026-09-03 incidents).
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_list_authorized_users(p_family_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT CASE WHEN COALESCE(admin_role(), '') NOT IN ('full', 'restricted') THEN '[]'::jsonb ELSE
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', u.id, 'name', u.name, 'email', u.email,
            'relationship', u.relationship, 'active', u.active,
            'login_locked', u.login_locked, 'created_at', u.created_at)
            ORDER BY u.created_at)
        FROM family_authorized_users u WHERE u.family_id = p_family_id), '[]'::jsonb)
    END;
$$;

CREATE OR REPLACE FUNCTION public.admin_add_authorized_user(
    p_family_id    uuid,
    p_name         text,
    p_email        text,
    p_relationship text,
    p_pin          text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_id bigint;
BEGIN
    IF COALESCE(admin_role(), '') NOT IN ('full', 'restricted') THEN RETURN NULL; END IF;
    IF COALESCE(btrim(p_name), '') = '' THEN RETURN jsonb_build_object('error', 'name_required'); END IF;
    IF COALESCE(btrim(p_email), '') = '' OR p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
        RETURN jsonb_build_object('error', 'invalid_email');
    END IF;
    IF p_pin !~ '^\d{4,8}$' THEN RETURN jsonb_build_object('error', 'invalid_pin'); END IF;

    -- Never let this table create an email that's ambiguous with an
    -- existing parent or another authorized user — family_login() is
    -- always tried first, so a collision here would silently mean
    -- "this person can never actually reach the trusted-party account
    -- they were just given."
    IF EXISTS (SELECT 1 FROM families
               WHERE lower(parent_email) = lower(p_email) OR lower(parent2_email) = lower(p_email))
    THEN
        RETURN jsonb_build_object('error', 'email_is_a_parent');
    END IF;
    IF EXISTS (SELECT 1 FROM family_authorized_users WHERE lower(email) = lower(p_email)) THEN
        RETURN jsonb_build_object('error', 'email_in_use');
    END IF;

    INSERT INTO family_authorized_users (family_id, name, email, relationship, pin_hash)
    VALUES (p_family_id, btrim(p_name), lower(btrim(p_email)), NULLIF(btrim(p_relationship), ''),
            crypt(p_pin, gen_salt('bf', 10)))
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_authorized_user(
    p_id           bigint,
    p_name         text,
    p_email        text,
    p_relationship text,
    p_active       boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF COALESCE(admin_role(), '') NOT IN ('full', 'restricted') THEN RETURN NULL; END IF;
    IF COALESCE(btrim(p_name), '') = '' THEN RETURN jsonb_build_object('error', 'name_required'); END IF;
    IF COALESCE(btrim(p_email), '') = '' OR p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
        RETURN jsonb_build_object('error', 'invalid_email');
    END IF;

    IF EXISTS (SELECT 1 FROM families
               WHERE lower(parent_email) = lower(p_email) OR lower(parent2_email) = lower(p_email))
    THEN
        RETURN jsonb_build_object('error', 'email_is_a_parent');
    END IF;
    IF EXISTS (SELECT 1 FROM family_authorized_users WHERE lower(email) = lower(p_email) AND id <> p_id) THEN
        RETURN jsonb_build_object('error', 'email_in_use');
    END IF;

    UPDATE family_authorized_users
    SET name = btrim(p_name), email = lower(btrim(p_email)),
        relationship = NULLIF(btrim(p_relationship), ''), active = p_active
    WHERE id = p_id;

    RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_reset_authorized_user_pin(p_id bigint, p_pin text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
    IF COALESCE(admin_role(), '') NOT IN ('full', 'restricted') THEN RETURN false; END IF;
    IF p_pin !~ '^\d{4,8}$' THEN RAISE EXCEPTION 'PIN must be 4–8 digits'; END IF;

    UPDATE family_authorized_users
    SET pin_hash = crypt(p_pin, gen_salt('bf', 10)), login_attempts = 0, login_locked = false
    WHERE id = p_id;

    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_remove_authorized_user(p_id bigint)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    DELETE FROM family_authorized_users
    WHERE id = p_id AND COALESCE(admin_role(), '') IN ('full', 'restricted')
    RETURNING true;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_authorized_users(uuid)                        TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_add_authorized_user(uuid, text, text, text, text)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_authorized_user(bigint, text, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reset_authorized_user_pin(bigint, text)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_remove_authorized_user(bigint)                     TO authenticated;

-- ------------------------------------------------------------
-- The login path. Mirrors family_login()'s shape and lockout
-- behavior exactly (5 attempts locks the ROW, not shared with the
-- family's own login_locked — one trusted party mistyping their PIN
-- must never lock the actual parents out) so parent-session can treat
-- either result uniformly.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.authorized_user_login(p_email text, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_user      family_authorized_users%ROWTYPE;
    v_family    families%ROWTYPE;
    v_attempts  int;
    v_students  jsonb;
    v_pin_ok    boolean;
BEGIN
    IF p_pin IS NULL OR p_pin !~ '^\d{4,8}$' THEN
        RETURN jsonb_build_object('error', 'invalid_pin', 'attempts_left', 5);
    END IF;

    SELECT * INTO v_user FROM family_authorized_users
    WHERE lower(email) = lower(p_email) AND active;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('error', 'not_found');
    END IF;
    IF v_user.login_locked THEN
        RETURN jsonb_build_object('error', 'login_locked');
    END IF;

    v_pin_ok := (v_user.pin_hash IS NOT NULL AND crypt(p_pin, v_user.pin_hash) = v_user.pin_hash);

    IF NOT v_pin_ok THEN
        v_attempts := COALESCE(v_user.login_attempts, 0) + 1;
        IF v_attempts >= 5 THEN
            UPDATE family_authorized_users SET login_locked = true, login_attempts = v_attempts WHERE id = v_user.id;
            RETURN jsonb_build_object('error', 'login_locked');
        ELSE
            UPDATE family_authorized_users SET login_attempts = v_attempts WHERE id = v_user.id;
            RETURN jsonb_build_object('error', 'invalid_pin', 'attempts_left', 5 - v_attempts);
        END IF;
    END IF;

    UPDATE family_authorized_users SET login_attempts = 0 WHERE id = v_user.id;

    SELECT * INTO v_family FROM families WHERE id = v_user.family_id;
    IF NOT FOUND OR v_family.login_locked THEN
        -- The family's own account is locked/gone; a trusted party
        -- shouldn't reach further than the family itself can.
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
$$;

GRANT EXECUTE ON FUNCTION public.authorized_user_login(text, text) TO anon;

-- ------------------------------------------------------------
-- parent_accounts gains a second identity shape: a row is either a
-- parent (parent_slot set) or a trusted third party
-- (authorized_user_id set), never neither, never both.
-- ------------------------------------------------------------

ALTER TABLE public.parent_accounts
    ADD COLUMN authorized_user_id bigint REFERENCES public.family_authorized_users(id) ON DELETE CASCADE;

ALTER TABLE public.parent_accounts
    ADD CONSTRAINT parent_accounts_identity_ck
        CHECK ((parent_slot IS NOT NULL) <> (authorized_user_id IS NOT NULL));

CREATE OR REPLACE FUNCTION public.my_parent_context()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT jsonb_build_object(
            'family_id', pa.family_id,
            'parent_slot', pa.parent_slot,
            'parent_name', CASE
                WHEN pa.authorized_user_id IS NOT NULL THEN au.name
                WHEN pa.parent_slot = 2 THEN f.parent2_name
                ELSE f.parent_name
            END,
            'family_name', f.parent_name,
            'email', pa.email,
            'is_authorized_user', pa.authorized_user_id IS NOT NULL)
         FROM parent_accounts pa
         JOIN families f ON f.id = pa.family_id
         LEFT JOIN family_authorized_users au ON au.id = pa.authorized_user_id
         WHERE pa.user_id = auth.uid()),
        'null'::jsonb);
$$;
