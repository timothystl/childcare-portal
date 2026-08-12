-- ============================================================
-- POLICY SCOPING — STAGE 1: the admin predicate
-- ============================================================
-- Plan: docs/POLICY_SCOPING_PLAN.md
--
-- Creates is_admin() / admin_role() and CHANGES NO POLICIES. Nothing behaves
-- differently after this migration; it exists so the predicate can be proven
-- correct before anything depends on it.
--
-- Why that matters: 27 tables are currently policied `FOR ALL TO authenticated
-- USING (true)`, and every admin tool reads them through a Supabase Auth
-- session, i.e. as `authenticated`. If this predicate is wrong when the
-- policies are switched over, the entire admin app goes dark at once. Stage 1
-- is deliberately inert so that cannot happen by surprise.
--
-- ⚠️ SECURITY DEFINER IS NOT OPTIONAL. is_admin() reads `settings`, and
-- `settings` is itself scheduled to become policy-protected in stage 3. An
-- invoker-rights function would then need is_admin() to evaluate is_admin() —
-- infinite recursion, and a total admin lockout. Definer rights read past RLS
-- and break the loop.
--
-- ⚠️ THESE FAIL CLOSED. No email claim, no `admin_roles` setting, or an email
-- absent from it all return false / NULL. That locks admins out rather than
-- letting strangers in, which is the correct direction: it is loud, and it is
-- fixed by restoring the setting. Note FS10 records the OPPOSITE bug in the
-- admin-users edge function, which fails OPEN on an empty admin_roles — worth
-- fixing at the same time so the two agree.
--
-- ROLLBACK: ROLLBACK_policy_scoping_stage1_admin_predicate.sql
-- ============================================================


-- ── is_admin() ───────────────────────────────────────────────
-- True when the caller's JWT email appears in settings.admin_roles.
-- Matching is case-insensitive: the setting is hand-edited, and an admin typing
-- their address with different capitalisation must not lock themselves out.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM settings s, jsonb_each_text(s.value::jsonb) kv
        WHERE s.key = 'admin_roles'
          AND COALESCE(auth.jwt() ->> 'email', '') <> ''
          AND lower(kv.key) = lower(auth.jwt() ->> 'email')
    );
$$;


-- ── admin_role() ─────────────────────────────────────────────
-- 'full' | 'restricted' | 'staff', or NULL for a non-admin. Wages, payroll and
-- finance policies will require 'full' — which is what makes the role tiers
-- real rather than a browser-side convention (R20).
CREATE OR REPLACE FUNCTION public.admin_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT kv.value
    FROM settings s, jsonb_each_text(s.value::jsonb) kv
    WHERE s.key = 'admin_roles'
      AND COALESCE(auth.jwt() ->> 'email', '') <> ''
      AND lower(kv.key) = lower(auth.jwt() ->> 'email')
    LIMIT 1;
$$;


-- Readable by the roles that will be evaluated against them. `parent_portal`
-- is included deliberately: once parents hold tokens, policies on shared tables
-- will read `is_admin() OR family_id = …`, and the predicate must be callable
-- in that context. It discloses nothing — it only ever answers about the
-- caller's own token.
GRANT EXECUTE ON FUNCTION public.is_admin()   TO authenticated, parent_portal;
GRANT EXECUTE ON FUNCTION public.admin_role() TO authenticated, parent_portal;
REVOKE EXECUTE ON FUNCTION public.is_admin()   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_role() FROM PUBLIC, anon;


-- ── Verification ─────────────────────────────────────────────
-- Simulates a JWT by setting request.jwt.claims, which is what auth.jwt()
-- reads. Raises rather than returning a row, so a failure cannot be skimmed
-- past. Transaction-local: nothing persists.
DO $$
DECLARE
    v_is   boolean;
    v_role text;
BEGIN
    -- A full admin
    PERFORM set_config('request.jwt.claims', '{"email":"mdo@timothystl.org"}', true);
    SELECT public.is_admin(), public.admin_role() INTO v_is, v_role;
    IF NOT v_is OR v_role <> 'full' THEN
        RAISE EXCEPTION 'FAILED: mdo@timothystl.org resolved is_admin=% role=%', v_is, v_role;
    END IF;

    -- Case-insensitivity
    PERFORM set_config('request.jwt.claims', '{"email":"DINGER@TimothyStl.org"}', true);
    SELECT public.is_admin() INTO v_is;
    IF NOT v_is THEN RAISE EXCEPTION 'FAILED: case-insensitive match'; END IF;

    -- A restricted admin keeps its tier
    PERFORM set_config('request.jwt.claims', '{"email":"amy.b.ricketts@gmail.com"}', true);
    SELECT public.admin_role() INTO v_role;
    IF v_role <> 'restricted' THEN
        RAISE EXCEPTION 'FAILED: restricted admin resolved role=%', v_role;
    END IF;

    -- A stranger
    PERFORM set_config('request.jwt.claims', '{"email":"a.parent@example.com"}', true);
    SELECT public.is_admin(), public.admin_role() INTO v_is, v_role;
    IF v_is OR v_role IS NOT NULL THEN
        RAISE EXCEPTION 'FAILED: non-admin resolved is_admin=% role=%', v_is, v_role;
    END IF;

    -- No email claim at all (a parent_portal token carries none)
    PERFORM set_config('request.jwt.claims', '{"role":"parent_portal"}', true);
    SELECT public.is_admin() INTO v_is;
    IF v_is THEN RAISE EXCEPTION 'FAILED: token without an email claim was treated as admin'; END IF;

    -- No claims at all
    PERFORM set_config('request.jwt.claims', '', true);
    SELECT public.is_admin() INTO v_is;
    IF v_is THEN RAISE EXCEPTION 'FAILED: empty claims were treated as admin'; END IF;

    RAISE NOTICE 'admin predicate: all cases passed';
END $$;
