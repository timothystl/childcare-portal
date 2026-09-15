-- ============================================================
-- R5 — ADMIN AUDIT LOG. APPLIED IN PRODUCTION 2026-08-03.
--
-- Supersedes add_audit_log.sql, which was committed but never run — so the
-- table, view and RPC had never existed. logAdminAction() (js/supabase.js)
-- calls the missing RPC from 26 sites; because supabase-js .rpc() RESOLVES
-- with {data, error} rather than throwing, the old try/catch never even
-- inspected the failure. Every admin action since launch went unrecorded and
-- nothing was ever printed. (js/supabase.js now checks `error` explicitly and
-- reports once at error level.)
--
-- Three hardening changes vs. the original, because new objects would
-- otherwise inherit Supabase's default privileges, which grant to `anon`:
--   1. the view is created WITH (security_invoker = true) so RLS on the base
--      table applies to it. A default Postgres view runs as its owner and
--      would have bypassed RLS entirely — an anon-readable audit log.
--   2. privileges are explicitly revoked from anon/PUBLIC, not left to defaults.
--   3. `authenticated` gets SELECT only — no UPDATE/DELETE/TRUNCATE. Writes go
--      solely through the SECURITY DEFINER RPC, so admin_email cannot be forged
--      and entries cannot be altered or removed from the client. That is what
--      makes "tamper-evident" accurate rather than aspirational.
--
-- Verified after applying: anon cannot read table or view; authenticated can
-- read but not UPDATE/DELETE; the RPC inserts correctly (probe row removed).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts          timestamptz NOT NULL DEFAULT now(),
    admin_email text        NOT NULL,
    action      text        NOT NULL,
    entity      text        NOT NULL,
    entity_id   text,
    details     jsonb
);

CREATE INDEX IF NOT EXISTS admin_audit_log_ts_idx  ON public.admin_audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS admin_audit_log_adm_idx ON public.admin_audit_log (admin_email);

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth read audit log" ON public.admin_audit_log;
CREATE POLICY "auth read audit log"
    ON public.admin_audit_log FOR SELECT
    TO authenticated
    USING (true);
-- Deliberately no INSERT/UPDATE/DELETE policy: the RPC below is the only writer.

CREATE OR REPLACE FUNCTION public.log_admin_action(
    p_action    text,
    p_entity    text,
    p_entity_id text  DEFAULT NULL,
    p_details   jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    INSERT INTO public.admin_audit_log (admin_email, action, entity, entity_id, details)
    VALUES (COALESCE(auth.email(), 'unknown'), p_action, p_entity, p_entity_id, p_details);
END;
$$;

CREATE OR REPLACE VIEW public.admin_audit_log_recent
WITH (security_invoker = true) AS
SELECT id, ts, admin_email, action, entity, entity_id, details
FROM   public.admin_audit_log
ORDER  BY ts DESC
LIMIT  500;

REVOKE ALL ON public.admin_audit_log        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.admin_audit_log_recent FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.log_admin_action(text, text, text, jsonb) FROM PUBLIC, anon;

GRANT SELECT ON public.admin_audit_log        TO authenticated;
GRANT SELECT ON public.admin_audit_log_recent TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_admin_action(text, text, text, jsonb) TO authenticated;
