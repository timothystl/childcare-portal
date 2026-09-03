-- ============================================================
-- CRITICAL FIX — set_family_pin() and set_staff_pin() had NO admin
-- gate and NO ownership check, while both are EXECUTE-granted to
-- `authenticated`.
-- ============================================================
-- Found while building the "additional trusted party" login feature —
-- reading set_family_pin() as a reference for how PINs get hashed
-- surfaced that it takes an arbitrary p_family_id with nothing checking
-- who is calling it.
--
-- set_family_pin(p_family_id, p_new_pin, p_is_parent2) — R2 (2026-08-02)
-- revoked EXECUTE from anon/PUBLIC, but left `authenticated`. At the
-- time every authenticated session was an admin, so that was safe. That
-- assumption died 2026-08-12 when parent_portal_option_b_accounts gave
-- families real Supabase Auth accounts (this file's own CLAUDE.md
-- documents that exact class of drift for TRUNCATE grants — this is the
-- same drift, on a function instead of a table grant). Since then, ANY
-- signed-in parent has been able to call
--   supabase.rpc('set_family_pin', {p_family_id: '<any other family>', p_new_pin: '1234'})
-- and overwrite a stranger's login PIN — full account takeover of any
-- family's portal session (children's info, billing, payments, PIN
-- reset for that family in turn).
--
-- set_staff_pin(p_staff_id, p_new_pin) has the identical shape and the
-- identical exposure: any parent could overwrite any staff member's
-- clock-in PIN.
--
-- Both are CREATE OR REPLACE — signatures are unchanged, so no grant
-- changes and no client-side changes are needed. Gated with the same
-- `COALESCE(admin_role(), '') NOT IN ('full', 'restricted')` idiom
-- already used throughout this schema (e.g. admin_add_incident_addendum),
-- with COALESCE specifically because admin_role() returns NULL — not a
-- string — for a normal parent, and this repo has already lost a day
-- once (the 2026-09-02 staff-credentials bug, same file) to an
-- un-coalesced NULL comparison silently failing to deny.
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_family_pin(
    p_family_id  uuid,
    p_new_pin    text,
    p_is_parent2 boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_hash text;
BEGIN
    IF COALESCE(admin_role(), '') NOT IN ('full', 'restricted') THEN
        RETURN;
    END IF;

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

CREATE OR REPLACE FUNCTION public.set_staff_pin(
    p_staff_id uuid,
    p_new_pin  integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
    IF COALESCE(admin_role(), '') NOT IN ('full', 'restricted') THEN
        RETURN;
    END IF;

    UPDATE staff
    SET staff_pin_hash = crypt(p_new_pin::text, gen_salt('bf', 10)), staff_pin = NULL
    WHERE id = p_staff_id;
END;
$$;
