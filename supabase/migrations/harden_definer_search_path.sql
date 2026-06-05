-- ============================================================
-- SS10 — Pin search_path on the remaining SECURITY DEFINER functions
-- ============================================================
-- Every other SECURITY DEFINER function in this project already sets
-- `search_path = public` (e.g. family_login, consume_pin_reset,
-- lookup_staff_by_pin, log_admin_action). These four were missing it:
--   - the three billing-by-email RPCs (add_billing_rpc.sql)
--   - the registration-window trigger function (enforce_registration_window.sql)
--
-- Without a pinned search_path, a definer function that references unqualified
-- objects (settings, families, billing_invoices, NOW(), …) can be tricked via
-- search_path manipulation into resolving a shadowed relation/function — a
-- privilege-escalation hardening gap. This is especially relevant for the
-- billing RPCs, which are (currently) granted to anon (see SS5).
--
-- ALTER FUNCTION only changes the configuration parameter; it does NOT rewrite
-- the function body, so this migration is non-invasive and safe to apply as-is.
-- (Argument-type modifiers like CHAR(7)/NUMERIC(10,2) are not needed to identify
-- the function — the base type names suffice.)
-- ============================================================

ALTER FUNCTION create_billing_invoice_by_email(text, char, numeric)
    SET search_path = public;

ALTER FUNCTION add_day_to_invoice_by_email(text, char, numeric, numeric)
    SET search_path = public;

ALTER FUNCTION get_outstanding_balance_by_email(text)
    SET search_path = public;

ALTER FUNCTION check_registration_window()
    SET search_path = public;
