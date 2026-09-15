-- ============================================================
-- TRACK STAX TRANSACTION FEE AND FUNDING METHOD (card vs ACH)
-- ============================================================
-- Until now, every Stax charge recorded a billing_payments row with
-- payment_method hardcoded to 'card' (see stax_finalize_charge below) and
-- no fee data at all — the office had no way to see what Stax actually
-- charged in fees, or which families are paying by card (and could be
-- steered to ACH once that's offered) versus already on a bank transfer.
--
-- Stax's own transaction object already carries both answers, verified
-- through the exact same authenticated GET /transaction/{id} call (or, for
-- a synchronous charge, the POST /charge response of the same shape) that
-- charge-stax-payment, stax-webhook, and reconcile-stax-payments already
-- use as their one source of truth:
--   * interchange_fee — the fee for that transaction.
--   * payment_method.method — 'card' or 'bank'.
-- See supabase/functions/_shared/stax-transaction-fields.ts, added
-- alongside this migration, for the one shared reading of these fields.
--
-- billing_payments.payment_method already documents an 'ach' value in its
-- original comment ('cash'|'check'|'ach'|'card'|'other') — this reuses that
-- existing column/vocabulary for Stax-originated rows instead of adding a
-- parallel column, rather than hardcoding 'card' regardless of how Stax
-- actually funded the charge.
--
-- Both new values are informational ledger metadata only. Neither is
-- trusted for anything money-moving — the charge amount, family, and
-- invoice allocation logic in stax_finalize_charge/stax_record_reversal is
-- entirely unchanged.
-- ============================================================

ALTER TABLE public.payment_charge_locks
    ADD COLUMN IF NOT EXISTS processor_fee numeric(12,2),
    ADD COLUMN IF NOT EXISTS payment_method text;

ALTER TABLE public.payment_charge_locks
    DROP CONSTRAINT IF EXISTS payment_charge_locks_payment_method_check,
    ADD CONSTRAINT payment_charge_locks_payment_method_check
        CHECK (payment_method IS NULL OR payment_method IN ('card', 'ach'));

ALTER TABLE public.billing_payments
    ADD COLUMN IF NOT EXISTS processor_fee numeric(12,2);

-- ── stax_set_charge_state gains two optional trailing parameters ────────
-- Adding parameters changes the function's signature (Postgres overloads on
-- argument list, not defaults), so the old 4-arg version is dropped rather
-- than left behind as an unrevoked sibling.
DROP FUNCTION IF EXISTS public.stax_set_charge_state(bigint, text, text, text);

CREATE FUNCTION public.stax_set_charge_state(
    p_lock_id bigint,
    p_status text,
    p_transaction_id text DEFAULT NULL,
    p_note text DEFAULT NULL,
    p_processor_fee numeric DEFAULT NULL,
    p_payment_method text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_lock public.payment_charge_locks%ROWTYPE;
    v_payment_method text;
BEGIN
    SELECT * INTO v_lock
      FROM public.payment_charge_locks
     WHERE id = p_lock_id AND processor = 'stax'
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Payment attempt not found.';
    END IF;
    IF v_lock.status = 'succeeded' THEN
        RETURN jsonb_build_object('status', v_lock.status, 'transactionId', v_lock.processor_transaction_id);
    END IF;
    IF p_status NOT IN ('ambiguous', 'processor_succeeded', 'failed') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid payment state.';
    END IF;
    IF p_status = 'processor_succeeded' AND coalesce(p_transaction_id, '') = '' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A successful processor transaction id is required.';
    END IF;
    -- Once authenticated processor success has been recorded, a slower
    -- response path must not downgrade the attempt to ambiguous or failed.
    IF v_lock.status = 'processor_succeeded' AND p_status <> 'processor_succeeded' THEN
        RETURN jsonb_build_object('status', v_lock.status, 'transactionId', v_lock.processor_transaction_id);
    END IF;
    IF v_lock.processor_transaction_id IS NOT NULL
       AND p_transaction_id IS NOT NULL
       AND v_lock.processor_transaction_id <> p_transaction_id THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Processor transaction id mismatch.';
    END IF;

    -- Fee/funding-method are informational ledger metadata read from Stax's
    -- own verified transaction response — never something a payment should
    -- fail or block over. An unrecognized value is simply dropped.
    v_payment_method := NULLIF(p_payment_method, '');
    IF v_payment_method IS NOT NULL AND v_payment_method NOT IN ('card', 'ach') THEN
        v_payment_method := NULL;
    END IF;

    UPDATE public.payment_charge_locks
       SET status = p_status,
           processor_transaction_id = coalesce(processor_transaction_id, p_transaction_id),
           processor_fee = coalesce(processor_fee, p_processor_fee),
           payment_method = coalesce(payment_method, v_payment_method),
           note = coalesce(p_note, note),
           updated_at = now(),
           resolved_at = CASE WHEN p_status = 'failed' THEN now() ELSE NULL END
     WHERE id = p_lock_id;

    RETURN jsonb_build_object('status', p_status, 'transactionId', p_transaction_id);
END
$function$;

-- ── stax_finalize_charge: carry fee (split proportionally across a ─────
-- rolled-up charge's invoices) and the real payment_method into the ledger,
-- instead of hardcoding 'card'. Signature is unchanged.
CREATE OR REPLACE FUNCTION public.stax_finalize_charge(p_lock_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_lock public.payment_charge_locks%ROWTYPE;
    v_row record;
    v_existing record;
    v_amount numeric(12,2);
    v_remaining numeric(12,2);
    v_balance_remaining numeric(12,2);
    v_any_new boolean := false;
    v_touched bigint[] := ARRAY[]::bigint[];
    v_inserted_id bigint;
    v_payment_method text;
    v_row_fee numeric(12,2);
    v_fee_remaining numeric(12,2);
BEGIN
    SELECT * INTO v_lock
      FROM public.payment_charge_locks
     WHERE id = p_lock_id AND processor = 'stax'
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Payment attempt not found.';
    END IF;
    IF v_lock.status = 'succeeded' THEN
        RETURN jsonb_build_object(
            'success', true, 'alreadyFinalized', true,
            'transactionId', v_lock.processor_transaction_id,
            'amount', v_lock.charge_amount
        );
    END IF;
    IF v_lock.status <> 'processor_succeeded'
       OR v_lock.processor_transaction_id IS NULL
       OR v_lock.charge_amount IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Processor success has not been confirmed.';
    END IF;

    v_payment_method := coalesce(v_lock.payment_method, 'card');
    v_fee_remaining := v_lock.processor_fee;

    -- Lock every invoice the rolled-up charge could touch. A concurrent
    -- payment insert must take a foreign-key key-share lock on these rows
    -- and therefore waits until this allocation commits.
    PERFORM i.id
      FROM public.billing_invoices i
      JOIN public.billing_cycles c ON c.id = i.cycle_id
     WHERE i.family_id = v_lock.family_id
       AND i.sent_at IS NOT NULL
       AND i.status IN ('sent', 'partial')
       AND trim(c.month::text) <= v_lock.anchor_month
     ORDER BY trim(c.month::text), i.id
     FOR UPDATE OF i;

    v_remaining := v_lock.charge_amount;
    FOR v_row IN
        SELECT * FROM public.stax_due_rows(v_lock.family_id, v_lock.anchor_month)
    LOOP
        EXIT WHEN v_remaining <= 0;
        v_amount := least(v_remaining, v_row.due);
        IF v_amount <= 0 THEN CONTINUE; END IF;

        -- The fee is one cost for the whole charge, not per invoice — split
        -- it proportionally to how much of the charge each invoice
        -- absorbed, the same way the charge amount itself is split just
        -- above, so a rolled-up two-invoice charge doesn't double-count the
        -- fee against each invoice. Rounding can leave a stray cent or two
        -- unattributed when a charge splits three or more ways; that's an
        -- accepted tolerance for informational fee tracking, never a reason
        -- to touch the money-moving amount above it.
        v_row_fee := CASE
            WHEN v_lock.processor_fee IS NOT NULL AND v_lock.charge_amount > 0
            THEN round(v_lock.processor_fee * v_amount / v_lock.charge_amount, 2)
            ELSE NULL
        END;

        v_inserted_id := NULL;
        INSERT INTO public.billing_payments (
            family_id, invoice_id, amount, payment_date, payment_method,
            note, created_by, processor, processor_transaction_id,
            processor_fee
        ) VALUES (
            v_lock.family_id, v_row.invoice_id, v_amount, current_date, v_payment_method,
            format('Stax online payment — invoice %s', v_row.invoice_id),
            'charge-stax-payment', 'stax',
            v_lock.processor_transaction_id || '-inv' || v_row.invoice_id,
            v_row_fee
        )
        ON CONFLICT DO NOTHING
        RETURNING id INTO v_inserted_id;

        IF v_inserted_id IS NULL THEN
            SELECT amount, family_id, invoice_id INTO v_existing
              FROM public.billing_payments
             WHERE processor = 'stax'
               AND processor_transaction_id = v_lock.processor_transaction_id || '-inv' || v_row.invoice_id;
            IF NOT FOUND OR v_existing.amount <> v_amount
               OR v_existing.family_id <> v_lock.family_id
               OR v_existing.invoice_id <> v_row.invoice_id THEN
                RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'Conflicting Stax payment allocation exists.';
            END IF;
        ELSE
            v_any_new := true;
            IF v_row_fee IS NOT NULL THEN
                v_fee_remaining := round(v_fee_remaining - v_row_fee, 2);
            END IF;
        END IF;

        v_touched := array_append(v_touched, v_row.invoice_id);
        v_remaining := round(v_remaining - v_amount, 2);
    END LOOP;

    -- If an office payment arrived after the processor amount was reserved,
    -- retain every charged cent as an unapplied family credit. Never discard
    -- money or force it onto an invoice that no longer owes it. Any fee left
    -- over from the proportional split above rides along with it rather
    -- than being silently dropped.
    IF v_remaining > 0 THEN
        v_inserted_id := NULL;
        INSERT INTO public.billing_payments (
            family_id, invoice_id, amount, payment_date, payment_method,
            note, created_by, processor, processor_transaction_id,
            processor_fee
        ) VALUES (
            v_lock.family_id, NULL, v_remaining, current_date, v_payment_method,
            'Stax online payment — unapplied credit after balance changed',
            'charge-stax-payment', 'stax',
            v_lock.processor_transaction_id || '-credit',
            v_fee_remaining
        )
        ON CONFLICT DO NOTHING
        RETURNING id INTO v_inserted_id;
        v_any_new := v_any_new OR v_inserted_id IS NOT NULL;

        INSERT INTO public.admin_audit_log (admin_email, action, entity, details)
        VALUES ('charge-stax-payment', 'online_payment_unapplied_credit', 'billing_payment',
                jsonb_build_object('family_id', v_lock.family_id,
                                   'transaction_id', v_lock.processor_transaction_id,
                                   'amount', v_remaining));
    END IF;

    UPDATE public.billing_invoices i
       SET status = CASE
           WHEN i.final_amount > 0 AND coalesce(p.total_paid, 0) >= i.final_amount THEN 'paid'
           WHEN coalesce(p.total_paid, 0) > 0 THEN 'partial'
           ELSE 'sent'
       END
      FROM (
          SELECT invoice_id, sum(amount) AS total_paid
            FROM public.billing_payments
           WHERE invoice_id = ANY(v_touched)
           GROUP BY invoice_id
      ) p
     WHERE i.id = p.invoice_id;

    SELECT coalesce(round(sum(due), 2), 0)
      INTO v_balance_remaining
      FROM public.stax_due_rows(v_lock.family_id, v_lock.anchor_month);

    UPDATE public.payment_charge_locks
       SET status = 'succeeded', resolved_at = now(), updated_at = now()
     WHERE id = v_lock.id;

    RETURN jsonb_build_object(
        'success', true,
        'alreadyFinalized', false,
        'anyNew', v_any_new,
        'transactionId', v_lock.processor_transaction_id,
        'amount', v_lock.charge_amount,
        'balanceRemaining', v_balance_remaining,
        'unappliedCredit', v_remaining,
        'touchedInvoiceIds', to_jsonb(v_touched)
    );
END
$function$;

-- ── stax_record_reversal: a refund/void of an ACH-funded payment should ─
-- say so too, not fall back to 'card' just because that used to be the only
-- value this function ever wrote. Signature is unchanged.
CREATE OR REPLACE FUNCTION public.stax_record_reversal(
    p_event_id text,
    p_parent_transaction_id text,
    p_kind text,
    p_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_row record;
    v_existing_amount numeric(12,2);
    v_reversible numeric(12,2);
    v_remaining numeric(12,2);
    v_amount numeric(12,2);
    v_inserted_id bigint;
    v_any_new boolean := false;
    v_touched bigint[] := ARRAY[]::bigint[];
BEGIN
    IF coalesce(p_event_id, '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR coalesce(p_parent_transaction_id, '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Reversal transaction ids are required.';
    END IF;
    IF p_kind NOT IN ('refund', 'void') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Unsupported reversal type.';
    END IF;
    IF p_amount IS NULL OR p_amount < 0.01 OR p_amount <> round(p_amount, 2) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid reversal amount.';
    END IF;

    -- Exact-event replay: return success only when the already-recorded sum
    -- matches the verified processor event. A reused id with a new amount is
    -- a mismatch, not an idempotent retry.
    SELECT coalesce(sum(abs(r.amount)), 0)
      INTO v_existing_amount
      FROM public.billing_payments r
      JOIN public.billing_payments original ON original.id = r.refund_of_payment_id
     WHERE r.processor = 'stax'
       AND r.processor_transaction_id LIKE p_event_id || '-row%'
       AND original.processor = 'stax'
       AND (original.processor_transaction_id = p_parent_transaction_id
            OR original.processor_transaction_id LIKE p_parent_transaction_id || '-inv%'
            OR original.processor_transaction_id = p_parent_transaction_id || '-credit');
    IF v_existing_amount > 0 THEN
        IF v_existing_amount <> p_amount THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Replayed reversal amount does not match the recorded event.';
        END IF;
        RETURN jsonb_build_object('received', true, 'anyNew', false, 'alreadyRecorded', true);
    END IF;

    -- Lock the original positive payment rows before computing how much is
    -- still reversible. This serializes two distinct partial-refund events.
    PERFORM p.id
      FROM public.billing_payments p
     WHERE p.processor = 'stax'
       AND p.amount > 0
       AND p.refund_of_payment_id IS NULL
       AND (p.processor_transaction_id = p_parent_transaction_id
            OR p.processor_transaction_id LIKE p_parent_transaction_id || '-inv%'
            OR p.processor_transaction_id = p_parent_transaction_id || '-credit')
     ORDER BY p.id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Original Stax transaction is not recorded yet.';
    END IF;

    SELECT coalesce(round(sum(greatest(original.amount - coalesce(reversed.total, 0), 0)), 2), 0)
      INTO v_reversible
      FROM public.billing_payments original
      LEFT JOIN (
          SELECT refund_of_payment_id, sum(abs(amount)) AS total
            FROM public.billing_payments
           WHERE refund_of_payment_id IS NOT NULL
           GROUP BY refund_of_payment_id
      ) reversed ON reversed.refund_of_payment_id = original.id
     WHERE original.processor = 'stax'
       AND original.amount > 0
       AND original.refund_of_payment_id IS NULL
       AND (original.processor_transaction_id = p_parent_transaction_id
            OR original.processor_transaction_id LIKE p_parent_transaction_id || '-inv%'
            OR original.processor_transaction_id = p_parent_transaction_id || '-credit');

    IF p_amount > v_reversible THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
            MESSAGE = format('Reversal amount $%s exceeds the recorded reversible amount $%s.',
                             to_char(p_amount, 'FM999999990.00'), to_char(v_reversible, 'FM999999990.00'));
    END IF;

    PERFORM i.id
      FROM public.billing_invoices i
     WHERE i.id IN (
         SELECT p.invoice_id FROM public.billing_payments p
          WHERE p.processor = 'stax'
            AND p.invoice_id IS NOT NULL
            AND (p.processor_transaction_id = p_parent_transaction_id
                 OR p.processor_transaction_id LIKE p_parent_transaction_id || '-inv%'
                 OR p.processor_transaction_id = p_parent_transaction_id || '-credit')
     )
     ORDER BY i.id
     FOR UPDATE;

    v_remaining := p_amount;
    FOR v_row IN
        SELECT original.id, original.invoice_id, original.family_id, original.amount,
               original.payment_method,
               greatest(original.amount - coalesce(sum(abs(reversal.amount)), 0), 0) AS available
          FROM public.billing_payments original
          LEFT JOIN public.billing_payments reversal ON reversal.refund_of_payment_id = original.id
          LEFT JOIN public.billing_invoices invoice ON invoice.id = original.invoice_id
          LEFT JOIN public.billing_cycles cycle ON cycle.id = invoice.cycle_id
         WHERE original.processor = 'stax'
           AND original.amount > 0
           AND original.refund_of_payment_id IS NULL
           AND (original.processor_transaction_id = p_parent_transaction_id
                OR original.processor_transaction_id LIKE p_parent_transaction_id || '-inv%'
                OR original.processor_transaction_id = p_parent_transaction_id || '-credit')
         GROUP BY original.id, original.payment_method, cycle.month
         ORDER BY cycle.month NULLS LAST, original.id
    LOOP
        EXIT WHEN v_remaining <= 0;
        v_amount := least(v_remaining, round(v_row.available, 2));
        IF v_amount <= 0 THEN CONTINUE; END IF;

        INSERT INTO public.billing_payments (
            family_id, invoice_id, amount, payment_date, payment_method,
            note, created_by, processor, processor_transaction_id,
            refund_of_payment_id
        ) VALUES (
            v_row.family_id, v_row.invoice_id, -v_amount, current_date, coalesce(v_row.payment_method, 'card'),
            format('Stax %s of payment #%s', p_kind, v_row.id),
            'stax-webhook', 'stax', p_event_id || '-row' || v_row.id, v_row.id
        )
        RETURNING id INTO v_inserted_id;

        v_any_new := true;
        IF v_row.invoice_id IS NOT NULL THEN
            v_touched := array_append(v_touched, v_row.invoice_id);
        END IF;
        v_remaining := round(v_remaining - v_amount, 2);
    END LOOP;

    IF v_remaining <> 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Reversal allocation did not consume the verified amount.';
    END IF;

    UPDATE public.billing_invoices i
       SET status = CASE
           WHEN i.final_amount > 0 AND coalesce(p.total_paid, 0) >= i.final_amount THEN 'paid'
           WHEN coalesce(p.total_paid, 0) > 0 THEN 'partial'
           ELSE 'sent'
       END
      FROM (
          SELECT invoice_id, sum(amount) AS total_paid
            FROM public.billing_payments
           WHERE invoice_id = ANY(v_touched)
           GROUP BY invoice_id
      ) p
     WHERE i.id = p.invoice_id;

    INSERT INTO public.admin_audit_log (admin_email, action, entity, details)
    VALUES ('stax-webhook', 'online_refund_or_void', 'billing_invoice',
            jsonb_build_object('invoice_ids', v_touched,
                               'parent_transaction_id', p_parent_transaction_id,
                               'event_transaction_id', p_event_id,
                               'kind', p_kind,
                               'amount', p_amount));

    RETURN jsonb_build_object(
        'received', true,
        'anyNew', v_any_new,
        'alreadyRecorded', false,
        'touchedInvoiceIds', to_jsonb(v_touched)
    );
END
$function$;

ALTER FUNCTION public.stax_set_charge_state(bigint, text, text, text, numeric, text) OWNER TO postgres;
ALTER FUNCTION public.stax_finalize_charge(bigint) OWNER TO postgres;
ALTER FUNCTION public.stax_record_reversal(text, text, text, numeric) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.stax_set_charge_state(bigint, text, text, text, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stax_set_charge_state(bigint, text, text, text, numeric, text) TO service_role;

-- stax_finalize_charge and stax_record_reversal keep their original
-- signatures, so their existing REVOKE/GRANT from the hardening migration
-- still applies — nothing to repeat here.

-- ============================================================
-- VERIFY (run after applying)
-- ============================================================
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name IN ('billing_payments', 'payment_charge_locks')
--      AND column_name IN ('processor_fee', 'payment_method');
--   → billing_payments has both (payment_method pre-existing); payment_charge_locks has both.
--
--   SELECT has_function_privilege('authenticated',
--     'public.stax_set_charge_state(bigint, text, text, text, numeric, text)', 'EXECUTE'); -- false
--
--   SELECT proname FROM pg_proc
--    WHERE proname = 'stax_set_charge_state';
--   → exactly one row (the old 4-arg overload was dropped, not left behind).
-- ============================================================
