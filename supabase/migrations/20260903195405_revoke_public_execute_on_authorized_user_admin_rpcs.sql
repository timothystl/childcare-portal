-- ============================================================
-- The admin_* RPCs for family_authorized_users (added in
-- 20260903195309_family_authorized_users.sql) were created without an
-- explicit REVOKE FROM PUBLIC/anon — a new Postgres function grants
-- EXECUTE to PUBLIC by default, which anon inherits. Each function's
-- own COALESCE(admin_role(), '') gate already fails closed for anon
-- (admin_role() reads auth.jwt() ->> 'email', which is empty for an
-- anonymous caller), so this was not exploitable — but this schema's
-- own standing rule (R26/R27: "revoke from both, then verify with
-- has_function_privilege rather than assuming") says to close it
-- explicitly rather than rely on the internal gate alone. Verified
-- live with has_function_privilege before and after this fix.
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.admin_list_authorized_users(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_add_authorized_user(uuid, text, text, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_update_authorized_user(bigint, text, text, text, boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_reset_authorized_user_pin(bigint, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_remove_authorized_user(bigint) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.admin_list_authorized_users(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_add_authorized_user(uuid, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_authorized_user(bigint, text, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reset_authorized_user_pin(bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_remove_authorized_user(bigint) TO authenticated;
