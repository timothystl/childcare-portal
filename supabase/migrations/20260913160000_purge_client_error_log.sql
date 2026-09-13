-- Migration: 20260913160000_purge_client_error_log.sql
-- ============================================================
-- Purge the client_error_log retention gap
-- ============================================================
-- client_error_log.sql created this table with a 90-day retention promise in
-- its OWN header comment ("Keep the table lean — auto-delete entries older
-- than 90 days.") and then left the actual deletion as a commented-out
-- `-- SELECT cron.schedule(...)` line captioned "Run this as a Supabase
-- scheduled function or manually as needed." Nobody ever ran it either way,
-- so every client-side JS error ever reported — every message, stack, page
-- path, and user agent string since the table was created — is still sitting
-- in production with no expiry. This migration is what should have shipped
-- alongside the table: a real, callable purge function. It does not schedule
-- anything (see the sweep-client-error-log Edge Function and the PR that adds
-- it for the NOT-YET-RUN pg_cron statement).
--
-- WHY 90 DAYS, SPECIFICALLY (not copied blindly from the old comment — it
-- still holds up under the same reasoning sweep_expired_child_photos' 7-day
-- daily-photo window uses: what is this data FOR, and what does the person
-- relying on it actually need):
--   * client_error_log is operational debugging exhaust — uncaught JS errors
--     and unhandled promise rejections from the parent portal, admin
--     dashboard, and clock-in kiosk. It exists so a developer can find and
--     fix a bug; it is not a family/child/staff/attendance/payment record and
--     carries none of THOSE tables' legal or financial retention floors
--     (contrast incident photos: guideline 3 years, statute of limitations 5,
--     major injury until the child turns 23 — a cron must never decide when
--     THAT documentation stops existing). Nothing here has a floor at all, so
--     the only question is how long a stack trace stays useful.
--   * 90 days is a full quarter of every surface this table watches. A bug
--     that only reproduces under a rare device/browser/network combination,
--     or only once a particular billing or schedule edge case comes up, can
--     easily skip weeks between occurrences — a week-scale window (like the
--     child-photo sweep, which is about a *promise made to parents on the
--     page*, not about how long the data stays diagnostically useful) would
--     throw away the second or third occurrence that turns "huh, weird" into
--     "here is the pattern."
--   * This table is also the one place in the schema where
--     `WITH CHECK (true)` lets anyone — including anon — insert a row (see
--     client_error_log.sql's "Public insert" policy: the parent portal has to
--     be able to report an error before a user ever authenticates). An
--     unbounded, publicly-writable table is a standing invitation to fill the
--     database with junk, accidentally or otherwise; 90 days caps how much
--     that can ever cost regardless of intent.
--   * Keeping it bounded also matters for schema_fingerprint / initDb-style
--     reasoning in the other Timothy repos: an observability table growing
--     forever is exactly the kind of thing that turns into a surprise
--     resource spike with no obvious cause.
--
-- Same shape as sweep_expired_child_photos() in phase1_child_photos_bucket_
-- APPLIED.sql: SECURITY DEFINER so the Edge Function can call it as
-- `authenticated` without needing table-level DELETE, revoked from PUBLIC and
-- anon (this must never be anon-callable — anon can INSERT into this table,
-- and must not also be able to wipe it), granted to authenticated only. The
-- calling Edge Function additionally gates on isAuthorizedCronRequest(), the
-- same X-Cron-Secret convention every other scheduled job in this project
-- uses (see supabase/functions/_shared/cron-auth.ts and
-- 20260909030842_scope_scheduled_job_credentials.sql).

CREATE OR REPLACE FUNCTION public.purge_client_error_log()
RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    WITH deleted AS (
        DELETE FROM client_error_log
        WHERE occurred_at < now() - interval '90 days'
        RETURNING id
    )
    SELECT count(*) FROM deleted;
$$;

REVOKE EXECUTE ON FUNCTION public.purge_client_error_log() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.purge_client_error_log() TO authenticated;
