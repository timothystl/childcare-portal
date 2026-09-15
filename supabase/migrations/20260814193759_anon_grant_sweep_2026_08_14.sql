-- ============================================================
-- Whole-schema anon privilege sweep — 2026-08-14
-- ============================================================
-- Follow-on from revoke_anon_delete_truncate_clock_events.sql. That one closed
-- DELETE/TRUNCATE on eight tables; this is the audit of everything else in
-- `public`, done because the R4 write-up had been wrong for months and no
-- write-up should be trusted over the catalog.
--
-- METHOD. A grant only matters if a policy lets it succeed. So every anon grant
-- was probed AS THE anon ROLE in rolled-back transactions rather than reasoned
-- about, because two earlier attempts at reasoning were wrong:
--
--   ⚠️ `polroles = '{0}'` means PUBLIC and therefore includes anon. A first
--      pass filtered policies on `'anon' = any(polroles)` and silently missed
--      the `Public insert` / `Auth read` policies on client_error_log and
--      waitlist_applications entirely.
--   ⚠️ `UPDATE t SET col = col` needs SELECT to evaluate `col`, so it fails on
--      missing SELECT and looks like RLS is holding. The real vector is a blind
--      `UPDATE t SET col = <constant>` with no WHERE, which needs no SELECT at
--      all. Only that form tests the policy.
--   ⚠️ An empty table updates 0 rows whatever the policy says. cacfp_menus and
--      deletion_requests were both empty, so a row was seeded as postgres
--      first and the probe re-run against it.
--
-- CONTROL that proves the method works: the same blind UPDATE against
-- staff_clock_events, which does have a permissive anon policy, reported
-- rows_updated_by_anon = 1547. Every revoke below reported 0 rows or 42501.

-- ── Dead grants: no policy permits them for anon ────────────
-- Each line was individually proven unusable by anon before being revoked, so
-- none of this can break a working path. They are removed anyway because a
-- dead grant is a live one the moment somebody adds a permissive policy — which
-- is exactly how the TRUNCATE hole would have been reached.

-- anon sees 0 of 147 rows (the `Auth read` policy requires authenticated);
-- blind UPDATE affects 0. INSERT is left alone — `Public insert` is real and is
-- how the browser error monitor files client-side errors.
REVOKE SELECT, UPDATE ON public.client_error_log FROM anon, PUBLIC;

-- anon INSERT blocked 42501 against a seeded row; blind UPDATE affects 0.
-- SELECT stays: `anon_select_published_cacfp_menus` scopes it to published
-- menus and the public menu page depends on it.
REVOKE INSERT, UPDATE ON public.cacfp_menus FROM anon, PUBLIC;

-- anon sees 0 of 1 seeded row; blind UPDATE affects 0. INSERT stays — the
-- public "delete my data" form is a real anon path.
REVOKE SELECT, UPDATE ON public.deletion_requests FROM anon, PUBLIC;

-- Blind UPDATE affects 0 of 605 / 6,064 rows.
--
-- INSERT is retained on both, but note what it is actually worth: a direct anon
-- INSERT into registration_dates ALREADY fails with "permission denied for
-- table registrations", because validating the FK needs SELECT on registrations
-- and R1 revoked that on 2026-08-11. Registration works because
-- submit_registration(jsonb) is SECURITY DEFINER and does both inserts as the
-- owner. So these INSERT grants are very likely vestigial too — but "likely" is
-- not the standard used anywhere else in this file, and revoking them is a
-- separate change that deserves its own probe of every remaining caller.
REVOKE UPDATE ON public.registrations FROM anon, PUBLIC;
REVOKE UPDATE ON public.registration_dates FROM anon, PUBLIC;

-- anon sees 0 of 150 rows — R1/R4 dropped the anon SELECT *policy* but left the
-- *grant* behind. This is the other half of that fix. INSERT stays.
REVOKE SELECT ON public.students FROM anon, PUBLIC;

-- anon sees 0 of 50 rows; blind UPDATE affects 0. `Auth all` is a PUBLIC-role
-- policy whose USING clause demands authenticated, so it never applied to anon.
-- INSERT stays — see the note on submit_waitlist_application below.
REVOKE SELECT, UPDATE ON public.waitlist_applications FROM anon, PUBLIC;

-- ============================================================
-- VERIFIED AFTER APPLYING — as the anon role, all rolled back
-- ============================================================
-- Revoked verbs now hard-fail instead of silently affecting 0 rows:
--   students SELECT · waitlist_applications SELECT · client_error_log SELECT
--   registrations UPDATE · registration_dates UPDATE      -> all 42501
--
-- Retained anon paths still work:
--   client_error_log INSERT   ok        families INSERT      ok
--   messages INSERT           ok        students INSERT      ok
--   registrations INSERT      ok        staff_clock_events INSERT ok
--   closures SELECT           sees 14   settings SELECT      sees room_rates
--
-- ⚠️ THE ONE THAT MATTERS — the real parent registration path, end to end:
--   submit_registration(jsonb) called AS anon -> ok, registration id 762,
--   1 registration_dates row, month_key '2026-10' computed server-side.
--
-- Afterwards: 605 registrations (unchanged), zero probe rows in any table.
--
-- ⚠️ Three probes gave false failures before the method was right, all worth
-- remembering: RETURNING needs SELECT (the .insert().select() trap, walked into
-- while testing for it); a subquery inside an INSERT needs SELECT on the table
-- it reads; and an FK check needs SELECT on the referenced table. A "permission
-- denied" from any of those is not evidence about the privilege being tested.
--
-- ============================================================
-- REVIEWED AND DELIBERATELY LEFT ALONE
-- ============================================================
--   closures      SELECT  — USING (true); the parent calendar needs it and a
--                           closure date is not private.
--   settings      SELECT  — scoped to a 13-key allow-list, which is the right
--                           shape. Nothing sensitive is in the list.
--   cacfp_menus   SELECT  — published rows only.
--   families/students/registrations/registration_dates/messages/
--   deletion_requests/client_error_log  INSERT — all real anon write paths.
--
--   create_billing_invoice_by_email — anon-executable, and pg_stat_statements
--   shows 161 genuine anon calls, so it cannot be revoked without breaking the
--   parent registration → invoice flow. Post-FS5-Phase-2 it ignores any
--   caller-supplied amount and recomputes the month server-side, so the worst
--   an attacker achieves is recomputing an invoice to its correct value. Left.
--
--   All 32 anon-executable SECURITY DEFINER functions have search_path pinned
--   (SS10 held). The only view, admin_audit_log_recent, has security_invoker
--   on and no anon SELECT. No materialized views exist.
--
-- ============================================================
-- ⚠️ STILL OPEN — NOT FIXABLE BY A REVOKE
-- ============================================================
-- staff_clock_events keeps SELECT/INSERT/UPDATE for anon, all three backed by
-- `USING (true)` policies, because the kiosk clock-out depends on the UPDATE
-- (~1,280 calls). The blast radius is larger than FS24 recorded — FS24 called
-- it "same-day cross-staff tampering". Measured here as anon:
--
--     UPDATE staff_clock_events SET room_id = 'probe';   -->  1547 rows
--
-- No WHERE clause needed. Anyone holding the public anon key can rewrite
-- clock_in and clock_out on every event in the table's history, which is the
-- payroll record. The anon SELECT (also USING (true)) additionally exposes
-- every staff member's hours.
--
-- The fix is a SECURITY DEFINER clock-out RPC keyed on the verified staff PIN —
-- the same shape as log_child_event — after which both the UPDATE and SELECT
-- policies can be dropped. That is a code change to clockin.html, not a grant
-- change, and it is the last permissive anon policy left in the schema.
