-- ============================================================
-- SS10 — Pin search_path on the remaining SECURITY DEFINER functions
-- ============================================================
-- Sets `search_path = public` on the billing-by-email RPCs and the
-- registration-window trigger function (the only SECURITY DEFINER functions
-- that were missing it). Without a pinned search_path, a definer function that
-- references unqualified objects can be tricked via search_path manipulation.
--
-- ROBUST VERSION: looks up each function by name (whatever its exact argument
-- signature) and ALTERs only the ones that actually exist — so it won't fail if,
-- e.g., the billing RPCs (add_billing_rpc.sql) were never applied to this DB.
-- ALTER FUNCTION only changes the config param; it does not rewrite the body.
-- ============================================================

DO $$
DECLARE
    fn record;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN (
              'create_billing_invoice_by_email',
              'add_day_to_invoice_by_email',
              'get_outstanding_balance_by_email',
              'check_registration_window'
          )
    LOOP
        EXECUTE format('ALTER FUNCTION %s SET search_path = public', fn.sig);
        RAISE NOTICE 'search_path pinned on %', fn.sig;
    END LOOP;
END $$;
