-- Migration: client_error_log.sql
-- Creates a lightweight client-side error log table for production observability.
-- The parent portal, admin dashboard, and clock-in page capture uncaught JS errors
-- and unhandled promise rejections and insert them here.
-- Admins can query this table directly in the Supabase dashboard to diagnose
-- production issues without needing a third-party service like Sentry.

CREATE TABLE IF NOT EXISTS client_error_log (
    id          bigserial    PRIMARY KEY,
    occurred_at timestamptz  NOT NULL DEFAULT now(),
    page        text,                           -- window.location.pathname
    message     text,                           -- Error.message (max 500 chars)
    stack       text,                           -- Error.stack (max 2000 chars)
    user_agent  text,                           -- navigator.userAgent (max 300 chars)
    context     jsonb                           -- extra metadata (filename, line, col, type)
);

ALTER TABLE client_error_log ENABLE ROW LEVEL SECURITY;

-- Anyone (including unauthenticated parent portal users) can insert error reports
CREATE POLICY "Public insert"
    ON client_error_log FOR INSERT
    WITH CHECK (true);

-- Only authenticated admins can read the error log
CREATE POLICY "Auth read"
    ON client_error_log FOR SELECT
    USING (auth.role() = 'authenticated');

-- Keep the table lean — auto-delete entries older than 90 days.
-- Run this as a Supabase scheduled function or manually as needed.
-- SELECT cron.schedule('purge-client-error-log', '0 3 * * *',
--   'DELETE FROM client_error_log WHERE occurred_at < now() - interval ''90 days'';');

-- Index for the admin dashboard view (most recent errors first)
CREATE INDEX IF NOT EXISTS client_error_log_occurred_idx
    ON client_error_log (occurred_at DESC);
