-- ============================================================
-- STAX PROCESSOR FEE SETTLEMENT BACKFILL
-- ============================================================
-- 20260912150000_track_stax_transaction_fee_and_funding_method.sql assumed
-- Stax's interchange_fee would be available on the same GET /transaction/{id}
-- response charge-stax-payment already reads synchronously. A real
-- production charge on 2026-09-14 (transaction
-- cc74254f-dd07-4177-a2f8-d54d1ee78634) proved that assumption wrong:
-- interchange_fee came back null even though the charge succeeded, while
-- batched_at was already set and settled_at was still null — the fee
-- appears to only be computed once Stax actually settles the transaction,
-- typically the next business day, not at authorization time.
--
-- backfill-stax-processor-fees (new edge function, scheduled below)
-- re-checks Stax for any billing_payments row still missing a fee, using
-- the exact same GET /transaction/{id} call and extractStaxPaymentFields()
-- reading every other Stax code path already trusts. This migration adds
-- the one RPC it needs to apply what it finds.
--
-- stax_backfill_processor_fee() is deliberately narrow: it only ever writes
-- processor_fee (never amount, invoice, or family), only to a Stax charge
-- row that doesn't have one yet, and splits a multi-invoice charge's fee
-- proportionally the exact same way stax_finalize_charge does at charge
-- time — so a backfilled fee looks identical to one that had been known
-- immediately. It is intentionally idempotent (WHERE processor_fee IS
-- NULL): calling it twice with the same transaction is a no-op the second
-- time, so the scheduled job can safely re-poll a transaction it already
-- backfilled without double-applying anything.
--
-- ⚠️ It remains possible Stax never populates interchange_fee this way at
-- all, and only ever reports real fee totals through a monthly merchant
-- statement instead. If so, this job costs nothing but a few no-op Stax API
-- calls a day — it never invents a number, and processor_fee simply stays
-- null. See backfill-stax-processor-fees/index.ts's header for what to
-- watch for before concluding that and building a monthly-statement import
-- instead.
-- ============================================================

CREATE FUNCTION public.stax_backfill_processor_fee(
    p_transaction_id text,
    p_processor_fee numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_total_amount numeric(12,2);
    v_row record;
    v_row_fee numeric(12,2);
    v_updated integer := 0;
BEGIN
    IF coalesce(p_transaction_id, '') = '' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A transaction id is required.';
    END IF;
    IF p_processor_fee IS NULL OR p_processor_fee < 0 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid processor fee.';
    END IF;

    -- Lock every row this transaction produced (invoice rows and/or the
    -- unapplied-credit row) before computing the proportional split, so a
    -- concurrent refund/void can't read a half-updated fee.
    PERFORM p.id
      FROM public.billing_payments p
     WHERE p.processor = 'stax'
       AND p.amount > 0
       AND p.refund_of_payment_id IS NULL
       AND (p.processor_transaction_id = p_transaction_id
            OR p.processor_transaction_id LIKE p_transaction_id || '-inv%'
            OR p.processor_transaction_id = p_transaction_id || '-credit')
     ORDER BY p.id
     FOR UPDATE;

    SELECT coalesce(sum(amount), 0) INTO v_total_amount
      FROM public.billing_payments
     WHERE processor = 'stax'
       AND amount > 0
       AND refund_of_payment_id IS NULL
       AND (processor_transaction_id = p_transaction_id
            OR processor_transaction_id LIKE p_transaction_id || '-inv%'
            OR processor_transaction_id = p_transaction_id || '-credit');

    IF v_total_amount <= 0 THEN
        RETURN jsonb_build_object('updated', 0, 'reason', 'no matching payment rows');
    END IF;

    FOR v_row IN
        SELECT id, amount
          FROM public.billing_payments
         WHERE processor = 'stax'
           AND amount > 0
           AND refund_of_payment_id IS NULL
           AND processor_fee IS NULL
           AND (processor_transaction_id = p_transaction_id
                OR processor_transaction_id LIKE p_transaction_id || '-inv%'
                OR processor_transaction_id = p_transaction_id || '-credit')
         ORDER BY id
    LOOP
        v_row_fee := round(p_processor_fee * v_row.amount / v_total_amount, 2);
        UPDATE public.billing_payments SET processor_fee = v_row_fee WHERE id = v_row.id;
        v_updated := v_updated + 1;
    END LOOP;

    RETURN jsonb_build_object('updated', v_updated);
END
$function$;

ALTER FUNCTION public.stax_backfill_processor_fee(text, numeric) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.stax_backfill_processor_fee(text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stax_backfill_processor_fee(text, numeric) TO service_role;

-- ── Schedule the backfill once a day. ────────────────────────────────────
-- Once daily, not every 30 minutes like reconcile-stax-payments — a fee
-- becoming available at settlement is an overnight event, not a
-- seconds-scale one, so there is nothing to gain from checking more often.
-- 12:00 UTC = 7am Central, safely after Stax's own settlement typically
-- completes for the prior business day.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'mymdo_cron_secret'
  ) THEN
    RAISE EXCEPTION 'Vault secret mymdo_cron_secret must exist before this migration is applied';
  END IF;
END
$$;

SELECT cron.schedule('backfill-stax-processor-fees', '0 12 * * *', $job$
  SELECT net.http_post(
    url := 'https://dahdstopsumxnqvdclmy.supabase.co/functions/v1/backfill-stax-processor-fees',
    headers := jsonb_build_object(
      'X-Cron-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'mymdo_cron_secret'),
      'Content-Type', 'application/json'
    ), body := '{}'::jsonb
  )
$job$);

-- ============================================================
-- VERIFY (run after applying)
-- ============================================================
--   SELECT has_function_privilege('authenticated',
--     'public.stax_backfill_processor_fee(text, numeric)', 'EXECUTE'); -- false
--   SELECT has_function_privilege('service_role',
--     'public.stax_backfill_processor_fee(text, numeric)', 'EXECUTE'); -- true
--   SELECT jobname FROM cron.job WHERE jobname = 'backfill-stax-processor-fees'; -- one row
-- ============================================================
