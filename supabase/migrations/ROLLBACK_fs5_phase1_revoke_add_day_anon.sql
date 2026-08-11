-- ============================================================
-- ROLLBACK — fs5_phase1_revoke_add_day_anon.sql
-- ============================================================
-- Restores anon EXECUTE on add_day_to_invoice_by_email.
--
-- You should not need this. The only caller is the admin "Add a Day" modal
-- (js/admin/admin-calendar.js:1042), which runs as `authenticated`, and
-- production pg_stat_statements shows zero anon calls to this function over
-- its entire lifetime. If the admin path breaks after Phase 1, the cause is
-- almost certainly something else — check that the admin session is actually
-- authenticated before re-granting anon.
--
-- The clamp (GREATEST(...,0)) is deliberately NOT reverted here: legitimate
-- callers only ever pass non-negative amounts, so it cannot be the cause of a
-- regression, and reverting it would reopen the zero-out vector.
-- ============================================================

GRANT EXECUTE ON FUNCTION public.add_day_to_invoice_by_email(TEXT, CHAR(7), NUMERIC, NUMERIC)
    TO anon;
