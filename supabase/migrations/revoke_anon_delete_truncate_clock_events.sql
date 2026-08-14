-- ============================================================
-- anon could TRUNCATE the payroll clock table with the public key
-- ============================================================
-- Found 2026-08-14 while adding device columns to staff_clock_events, by
-- reading relacl rather than trusting the R4 write-up in CLAUDE.md.
--
--   relacl: anon=arwdDxtm/postgres
--                  ^^^^ d = DELETE, D = TRUNCATE
--
-- R4 describes anon as holding "SELECT/INSERT/UPDATE" on this table. It holds
-- **every** privilege, including DELETE and TRUNCATE. Two very different risks:
--
--   DELETE — grant present but NOT exploitable. RLS is enabled and there is no
--            DELETE policy for anon, so the statement affects zero rows.
--            Proven as the anon role in a rolled-back transaction:
--            before=1547, deleted_by_anon=0, after=1547.
--
--   ⚠️ TRUNCATE — exploitable. **TRUNCATE is not subject to row-level
--            security**; RLS filters rows, and TRUNCATE does not read rows. The
--            privilege alone is sufficient. Anyone holding the public anon key
--            — which ships in the browser on every page of this site — could
--            have erased all 1,547 clock events, i.e. every payroll record
--            since 2026-03-04, in one statement. There is no soft delete and
--            no application-level copy; the only recovery would be a database
--            restore.
--
-- Deliberately NOT tested by executing a TRUNCATE against live payroll data.
-- has_table_privilege reports the grant, and TRUNCATE-ignores-RLS is documented
-- Postgres behavior; that is sufficient, and a rolled-back TRUNCATE would still
-- have taken an ACCESS EXCLUSIVE lock on the table staff clock in against.
--
-- Safe to revoke: the DELETE probe above proves nothing in the app can be
-- relying on either verb, because neither can currently succeed for anon
-- (TRUNCATE is not something any browser code path issues). SELECT, INSERT and
-- UPDATE are left exactly as they were — UPDATE in particular is how the kiosk
-- clocks staff out (~1,280 calls), and dropping it would break clock-out.

REVOKE DELETE, TRUNCATE ON public.staff_clock_events FROM anon;

-- ⚠️ Revoke from PUBLIC too. Supabase's default privileges can grant directly
-- to a role AND leave an inherited PUBLIC grant standing; revoking one is not
-- revoking the other. Verify with has_table_privilege, never by assuming.
REVOKE DELETE, TRUNCATE ON public.staff_clock_events FROM PUBLIC;

-- ============================================================
-- VERIFIED AFTER APPLYING
-- ============================================================
--   anon DELETE   -> false
--   anon TRUNCATE -> false
--   anon SELECT / INSERT / UPDATE -> still true (clock-out keeps working)
--
-- ⚠️ STILL OPEN, and worth a dedicated pass: this table is not the only one
-- with a blanket `arwdDxtm` grant to anon. Audit every table in `public` with
-- `relacl` for the D bit before assuming RLS is protecting anything — RLS does
-- not stop TRUNCATE anywhere.

-- ============================================================
-- SAME HOLE ON SEVEN MORE TABLES — swept 2026-08-14
-- ============================================================
-- The audit suggested above was run immediately rather than left as a note,
-- because the answer was bad: `anon` held DELETE **and TRUNCATE** on
--
--   registrations · registration_dates · staff · waitlist_applications
--   cacfp_menus · client_error_log · deletion_requests
--
-- RLS is enabled on all seven, which is exactly what made this invisible —
-- and RLS does not stop TRUNCATE. With the public anon key, one statement per
-- table would have erased every registration, every care date, the staff
-- roster and the waitlist.
--
-- Verified safe before revoking: NOT ONE of the seven has a DELETE policy
-- naming anon (checked pg_policy.polroles, not assumed from the write-ups).
-- Their DELETE policies are all `admin any role` / `admin full only` /
-- `Auth all` / service-role, i.e. `authenticated` paths that this revoke does
-- not touch. So no anon DELETE can succeed today, and nothing that works can
-- break. SELECT/INSERT/UPDATE are left untouched throughout — several are
-- load-bearing (registration submit, the kiosk clock-out).
REVOKE DELETE, TRUNCATE ON
    public.registrations, public.registration_dates, public.staff,
    public.waitlist_applications, public.cacfp_menus,
    public.client_error_log, public.deletion_requests
FROM anon, PUBLIC;

-- VERIFIED AFTER APPLYING: anon TRUNCATE and DELETE are false on all eight
-- tables (the seven above plus staff_clock_events); anon SELECT/INSERT/UPDATE
-- unchanged on each.
