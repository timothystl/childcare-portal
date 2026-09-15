-- APPLIED TO PRODUCTION 2026-08-12 (supabase_migrations version 20260812043259).
--
-- OPTION B — parents as real Supabase Auth users.
--
-- Replaces the hand-signed HS256 token from Phase 0, which depended on the
-- LEGACY JWT secret. That secret is verification-only and on a deprecation
-- path; when it is finally revoked, anything signed with it dies. Real auth
-- users survive the rotation.
--
-- ⚠️ WHY THIS IS SAFE NOW AND WAS NOT BEFORE.
-- A Supabase Auth user's token carries role = 'authenticated'. Until today
-- that role had blanket access to 27 tables including staff wages and the
-- billing ledger, so giving parents auth accounts would have been a breach.
-- policy_scoping stages 1-5 scoped every one of those to is_admin(), so a
-- parent holding an authenticated token now gets NOTHING by default. Access
-- comes only from explicit parent policies keyed through this table.
--
-- That also removes the need for a custom access-token hook rewriting the role
-- claim, which would have made the whole boundary depend on a hook firing
-- correctly forever.

CREATE TABLE IF NOT EXISTS public.parent_accounts (
    user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
    -- 1 or 2, or NULL when one address covers both parents. Two people sharing
    -- an inbox (a real case here — the Millers) cannot have two auth users,
    -- because Supabase Auth keys on email. They share the login, which is how
    -- they already share the mailbox.
    parent_slot smallint CHECK (parent_slot IN (1, 2)),
    email       text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
);

CREATE INDEX IF NOT EXISTS parent_accounts_family_idx ON public.parent_accounts (family_id);
CREATE UNIQUE INDEX IF NOT EXISTS parent_accounts_email_key ON public.parent_accounts (lower(email));

ALTER TABLE public.parent_accounts ENABLE ROW LEVEL SECURITY;

-- No policy for anyone. Written by the parent-session edge function with the
-- service role; read only through parent_family_ids() below, which is definer.
-- A parent must never be able to see or alter the mapping that decides which
-- family they are.
REVOKE ALL ON public.parent_accounts FROM anon, authenticated;

-- The predicate every parent-facing policy will use:
--     USING (family_id IN (SELECT parent_family_ids()))
-- Definer so it can read parent_accounts past that table's own RLS.
CREATE OR REPLACE FUNCTION public.parent_family_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT pa.family_id FROM parent_accounts pa WHERE pa.user_id = auth.uid();
$$;

REVOKE EXECUTE ON FUNCTION public.parent_family_ids() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.parent_family_ids() TO authenticated;

-- Convenience for the app: "am I a parent, and for which family".
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
            'parent_name', CASE WHEN pa.parent_slot = 2 THEN f.parent2_name ELSE f.parent_name END,
            'family_name', f.parent_name,
            'email', pa.email)
         FROM parent_accounts pa JOIN families f ON f.id = pa.family_id
         WHERE pa.user_id = auth.uid()),
        'null'::jsonb);
$$;

REVOKE EXECUTE ON FUNCTION public.my_parent_context() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.my_parent_context() TO authenticated;
