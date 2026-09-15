-- ============================================================
-- R26 COMPLETION — anon could read staff wages and payroll hours
-- ============================================================
-- APPLIED AND VERIFIED IN PRODUCTION 2026-08-11.
--
-- R26 is recorded in CLAUDE.md as having narrowed anon to display columns on
-- `staff`, and marked verified. It was not. Two things were still live through
-- the public anon key that ships in every browser:
--
--   * column-level SELECT on staff.hourly_rate and staff.salary_biweekly
--     (also email, hire_date, pay_type, created_at)
--   * SELECT/INSERT/UPDATE/DELETE on staff_hours — 151 rows of payroll hours
--     across 33 staff
--
-- HOW IT WAS BEING REACHED
-- ------------------------
-- pg_stat_statements shows anon running exactly payroll.html's query:
--   SELECT id, name, role, pay_type, hourly_rate, salary_biweekly, room_id,
--          active FROM staff WHERE active = $1 ORDER BY name
-- payroll.html gates correctly on Supabase Auth, so this is not an unprotected
-- page. It is an EXPIRED SESSION falling back to the anon role: getSession()
-- returns a stale session from localStorage, showDashboard() runs, and the
-- queries go out unauthenticated. Because anon held the grants, they SUCCEEDED
-- and returned wages instead of failing.
--
-- That is the real lesson here: the grant is what turned a stale-session bug
-- into a data exposure. With the grant gone, the same bug is now a visible
-- error, which is what it should always have been.
--
-- WHY THE REVOKE IS SAFE
-- ----------------------
-- No public page reads either table directly — verified across clockin,
-- index, lookup, calendar, menu, inquiry, waitlist-status, enroll, reset-pin
-- and notice: zero occurrences of from('staff') or from('staff_hours').
-- The kiosk uses lookup_staff_by_pin, which is SECURITY DEFINER (bypasses
-- grants entirely) and returns only id/name/role/room_id/pay_type.
--
-- ROLLBACK: ROLLBACK_r26_complete_revoke_anon_staff_wages.sql
-- ============================================================

REVOKE SELECT (hourly_rate, salary_biweekly, email, hire_date, pay_type, created_at)
    ON public.staff FROM anon;

REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES
    ON public.staff_hours FROM anon;

-- ── Verification (all passed post-apply) ─────────────────────
--   anon columns on staff:  active, has_staff_pin, id, name, role, room_id
--   anon hourly_rate  -> false      anon salary_biweekly -> false
--   anon staff_hours SELECT -> false   anon staff_hours UPDATE -> false
--   authenticated admin still reads wages and staff_hours -> ok
--
-- ⚠️ FOLLOW-UP (app-side, not fixed here): payroll.html should re-check the
-- session before querying rather than trusting a stale getSession(). With this
-- revoke the page now errors on an expired session instead of silently showing
-- wages — correct, but it should bounce to the login screen instead.
