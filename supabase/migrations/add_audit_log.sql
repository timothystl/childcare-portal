-- ============================================================
-- ADMIN AUDIT LOG
-- ============================================================
-- Records every significant admin action (create, update, delete,
-- lock/unlock, rate change, etc.) for accountability and debugging.
--
-- Written from the client via the log_admin_action() RPC so that
-- the current authenticated user's email is captured server-side
-- (auth.email() is not spoofable from the client).
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts          timestamptz NOT NULL DEFAULT now(),
    admin_email text        NOT NULL,
    action      text        NOT NULL,  -- verb: 'delete', 'update', 'create', 'lock', etc.
    entity      text        NOT NULL,  -- table / domain: 'registration', 'family', 'student', 'rate', etc.
    entity_id   text,                  -- primary key of affected row (nullable for bulk ops)
    details     jsonb                  -- additional context (old/new values, child name, etc.)
);

-- Index for the most common query pattern: recent actions, newest first
CREATE INDEX IF NOT EXISTS admin_audit_log_ts_idx  ON admin_audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS admin_audit_log_adm_idx ON admin_audit_log (admin_email);

-- RLS: only authenticated admins can read; log_admin_action() RPC handles writes
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read audit log"
    ON admin_audit_log FOR SELECT
    TO authenticated
    USING (true);

-- No direct INSERT policy — clients must use the RPC below
-- (prevents clients from forging the admin_email field).

-- ============================================================
-- RPC: log_admin_action
-- Called by the admin JS after each significant operation.
-- The admin_email is captured from auth.email() server-side.
-- ============================================================
CREATE OR REPLACE FUNCTION public.log_admin_action(
    p_action    text,
    p_entity    text,
    p_entity_id text    DEFAULT NULL,
    p_details   jsonb   DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO admin_audit_log (admin_email, action, entity, entity_id, details)
    VALUES (
        auth.email(),
        p_action,
        p_entity,
        p_entity_id,
        p_details
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_admin_action(text, text, text, jsonb) TO authenticated;

-- ============================================================
-- Helper view: recent 500 log entries (for the admin UI)
-- ============================================================
CREATE OR REPLACE VIEW admin_audit_log_recent AS
SELECT id, ts, admin_email, action, entity, entity_id, details
FROM   admin_audit_log
ORDER  BY ts DESC
LIMIT  500;
