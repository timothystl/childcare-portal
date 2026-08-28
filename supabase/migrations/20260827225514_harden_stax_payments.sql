-- ============================================================
-- HARDEN STAX PAYMENTS
-- ============================================================
-- NOTE (2026-08-28): this file was originally committed as
-- 20260827193636_harden_stax_payments.sql; the live catalog recorded it as
-- 20260827225514. Renamed to match what was actually applied, per this
-- repo's own rule that a migration's filename/content should match the
-- deployed state — found and fixed during an external security review that
-- diffed the repo against the live migration history. Content is unchanged
-- and was verified to match the deployed function bodies before renaming.
--
-- The processor call cannot participate in a Postgres transaction, but all
-- database work on either side of it can. This migration provides four
-- service-role-only primitives:
--   * quote a family's issued balance through an anchor invoice;
--   * reserve one family-wide Stax attempt with a stable idempotency key;
--   * record the processor outcome and allocate a successful charge in one
--     transaction (including an unapplied credit if the balance changed);
--   * record a verified refund/void in one transaction.
--
-- None of these functions is a browser API. Edge functions authenticate the
-- caller and establish invoice ownership before invoking them with the
-- service role. Explicit revokes below prevent the usual PUBLIC-function
-- default from turning a SECURITY DEFINER helper into an API endpoint.

ALTER TABLE public.payment_charge_locks
    ADD COLUMN IF NOT EXISTS charge_amount numeric(12,2),
    ADD COLUMN IF NOT EXISTS anchor_month text,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.payment_charge_locks
    DROP CONSTRAINT IF EXISTS payment_charge_locks_status_check;

ALTER TABLE public.payment_charge_locks
    ADD CONSTRAINT payment_charge_locks_status_check
    CHECK (status IN ('pending', 'ambiguous', 'processor_succeeded', 'succeeded', 'failed'));

DROP INDEX IF EXISTS public.payment_charge_locks_pending_idx;

-- A payment opened from March and one opened from April can cover overlapping
-- prior balances. Serialize by family, not merely by the clicked invoice.
CREATE UNIQUE INDEX IF NOT EXISTS payment_charge_locks_active_family_idx
    ON public.payment_charge_locks (family_id)
    WHERE status IN ('pending', 'ambiguous', 'processor_succeeded');

CREATE UNIQUE INDEX IF NOT EXISTS payment_charge_locks_idempotency_idx
    ON public.payment_charge_locks (processor, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS families_stax_customer_id_idx
    ON public.families (stax_customer_id)
    WHERE stax_customer_id IS NOT NULL;

ALTER TABLE public.families
    DROP CONSTRAINT IF EXISTS families_stax_last_four_check,
    ADD CONSTRAINT families_stax_last_four_check
        CHECK (stax_default_card_last_four IS NULL OR stax_default_card_last_four ~ '^[0-9]{4}$'),
    DROP CONSTRAINT IF EXISTS families_stax_saved_card_customer_check,
    ADD CONSTRAINT families_stax_saved_card_customer_check
        CHECK (stax_default_payment_method_id IS NULL OR stax_customer_id IS NOT NULL);

CREATE OR REPLACE FUNCTION public.stax_due_rows(
    p_family_id uuid,
    p_anchor_month text
)
RETURNS TABLE (invoice_id bigint, invoice_month text, due numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
    SELECT i.id,
           trim(c.month::text) AS invoice_month,
           round(i.final_amount - coalesce(sum(p.amount), 0), 2) AS due
      FROM public.billing_invoices i
      JOIN public.billing_cycles c ON c.id = i.cycle_id
      LEFT JOIN public.billing_payments p ON p.invoice_id = i.id
     WHERE i.family_id = p_family_id
       AND i.sent_at IS NOT NULL
       AND i.status IN ('sent', 'partial')
       AND trim(c.month::text) <= p_anchor_month
     GROUP BY i.id, c.month, i.final_amount
    HAVING round(i.final_amount - coalesce(sum(p.amount), 0), 2) > 0
     ORDER BY trim(c.month::text), i.id
$function$;

CREATE OR REPLACE FUNCTION public.stax_quote_balance(
    p_invoice_id bigint,
    p_family_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_anchor_month text;
    v_status text;
    v_sent_at timestamptz;
    v_total numeric(12,2);
    v_prior numeric(12,2);
    v_rows jsonb;
    v_unapplied_credit numeric(12,2);
BEGIN
    SELECT trim(c.month::text), i.status, i.sent_at
      INTO v_anchor_month, v_status, v_sent_at
      FROM public.billing_invoices i
      JOIN public.billing_cycles c ON c.id = i.cycle_id
     WHERE i.id = p_invoice_id
       AND i.family_id = p_family_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Invoice not found for family.';
    END IF;
    IF v_sent_at IS NULL OR v_status NOT IN ('sent', 'partial') THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'This bill has not been issued or is no longer payable.';
    END IF;

    SELECT coalesce(round(sum(amount), 2), 0)
      INTO v_unapplied_credit
      FROM public.billing_payments
     WHERE family_id = p_family_id AND invoice_id IS NULL;
    IF v_unapplied_credit > 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001',
            MESSAGE = format('Your account has an unapplied $%s credit. Please contact the office before paying again.',
                             to_char(v_unapplied_credit, 'FM999999990.00'));
    END IF;

    SELECT coalesce(round(sum(d.due), 2), 0),
           coalesce(round(sum(d.due) FILTER (WHERE d.invoice_month < v_anchor_month), 2), 0),
           coalesce(jsonb_agg(jsonb_build_object(
               'invoiceId', d.invoice_id,
               'month', d.invoice_month,
               'due', d.due
           ) ORDER BY d.invoice_month, d.invoice_id), '[]'::jsonb)
      INTO v_total, v_prior, v_rows
      FROM public.stax_due_rows(p_family_id, v_anchor_month) d;

    IF v_total <= 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'This bill is already paid in full.';
    END IF;

    RETURN jsonb_build_object(
        'amount', v_total,
        'priorBalance', v_prior,
        'anchorMonth', v_anchor_month,
        'dueRows', v_rows
    );
END
$function$;

CREATE OR REPLACE FUNCTION public.stax_prepare_charge(
    p_invoice_id bigint,
    p_family_id uuid,
    p_requested_amount numeric,
    p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_existing public.payment_charge_locks%ROWTYPE;
    v_quote jsonb;
    v_balance numeric(12,2);
    v_amount numeric(12,2);
    v_lock_id bigint;
BEGIN
    IF p_idempotency_key IS NULL
       OR p_idempotency_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid payment attempt id.';
    END IF;

    -- The row lock closes the prepare/insert race; the partial unique index
    -- keeps the family reserved after this transaction commits.
    PERFORM 1 FROM public.families WHERE id = p_family_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Family not found.';
    END IF;

    SELECT * INTO v_existing
      FROM public.payment_charge_locks
     WHERE processor = 'stax' AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF v_existing.family_id <> p_family_id OR v_existing.invoice_id <> p_invoice_id THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Payment attempt does not match this invoice.';
        END IF;
        RETURN jsonb_build_object(
            'existing', true,
            'lockId', v_existing.id,
            'status', v_existing.status,
            'amount', v_existing.charge_amount,
            'transactionId', v_existing.processor_transaction_id
        );
    END IF;

    v_quote := public.stax_quote_balance(p_invoice_id, p_family_id);
    v_balance := (v_quote->>'amount')::numeric;
    v_amount := coalesce(p_requested_amount, v_balance);

    IF v_amount <> round(v_amount, 2) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Payment amount cannot have more than two decimal places.';
    END IF;
    IF v_amount < 0.01 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Payment amount must be at least $0.01.';
    END IF;
    IF v_amount > v_balance THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
            MESSAGE = format('Payment amount cannot exceed the current $%s balance.', to_char(v_balance, 'FM999999990.00'));
    END IF;

    INSERT INTO public.payment_charge_locks (
        invoice_id, family_id, processor, status, idempotency_key,
        charge_amount, anchor_month, updated_at
    ) VALUES (
        p_invoice_id, p_family_id, 'stax', 'pending', p_idempotency_key,
        v_amount, v_quote->>'anchorMonth', now()
    )
    RETURNING id INTO v_lock_id;

    RETURN jsonb_build_object(
        'existing', false,
        'lockId', v_lock_id,
        'status', 'pending',
        'amount', v_amount,
        'balance', v_balance,
        'anchorMonth', v_quote->>'anchorMonth'
    );
EXCEPTION
    WHEN unique_violation THEN
        RAISE EXCEPTION USING ERRCODE = '55P03',
            MESSAGE = 'Another payment for this family is already being processed.';
END
$function$;

CREATE OR REPLACE FUNCTION public.stax_set_charge_state(
    p_lock_id bigint,
    p_status text,
    p_transaction_id text DEFAULT NULL,
    p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_lock public.payment_charge_locks%ROWTYPE;
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

    UPDATE public.payment_charge_locks
       SET status = p_status,
           processor_transaction_id = coalesce(processor_transaction_id, p_transaction_id),
           note = coalesce(p_note, note),
           updated_at = now(),
           resolved_at = CASE WHEN p_status = 'failed' THEN now() ELSE NULL END
     WHERE id = p_lock_id;

    RETURN jsonb_build_object('status', p_status, 'transactionId', p_transaction_id);
END
$function$;

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

        v_inserted_id := NULL;
        INSERT INTO public.billing_payments (
            family_id, invoice_id, amount, payment_date, payment_method,
            note, created_by, processor, processor_transaction_id
        ) VALUES (
            v_lock.family_id, v_row.invoice_id, v_amount, current_date, 'card',
            format('Stax online payment — invoice %s', v_row.invoice_id),
            'charge-stax-payment', 'stax',
            v_lock.processor_transaction_id || '-inv' || v_row.invoice_id
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
        END IF;

        v_touched := array_append(v_touched, v_row.invoice_id);
        v_remaining := round(v_remaining - v_amount, 2);
    END LOOP;

    -- If an office payment arrived after the processor amount was reserved,
    -- retain every charged cent as an unapplied family credit. Never discard
    -- money or force it onto an invoice that no longer owes it.
    IF v_remaining > 0 THEN
        v_inserted_id := NULL;
        INSERT INTO public.billing_payments (
            family_id, invoice_id, amount, payment_date, payment_method,
            note, created_by, processor, processor_transaction_id
        ) VALUES (
            v_lock.family_id, NULL, v_remaining, current_date, 'card',
            'Stax online payment — unapplied credit after balance changed',
            'charge-stax-payment', 'stax',
            v_lock.processor_transaction_id || '-credit'
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
         GROUP BY original.id, cycle.month
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
            v_row.family_id, v_row.invoice_id, -v_amount, current_date, 'card',
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

ALTER FUNCTION public.stax_due_rows(uuid, text) OWNER TO postgres;
ALTER FUNCTION public.stax_quote_balance(bigint, uuid) OWNER TO postgres;
ALTER FUNCTION public.stax_prepare_charge(bigint, uuid, numeric, text) OWNER TO postgres;
ALTER FUNCTION public.stax_set_charge_state(bigint, text, text, text) OWNER TO postgres;
ALTER FUNCTION public.stax_finalize_charge(bigint) OWNER TO postgres;
ALTER FUNCTION public.stax_record_reversal(text, text, text, numeric) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.stax_due_rows(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stax_quote_balance(bigint, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stax_prepare_charge(bigint, uuid, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stax_set_charge_state(bigint, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stax_finalize_charge(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stax_record_reversal(text, text, text, numeric) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.stax_due_rows(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.stax_quote_balance(bigint, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.stax_prepare_charge(bigint, uuid, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.stax_set_charge_state(bigint, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.stax_finalize_charge(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.stax_record_reversal(text, text, text, numeric) TO service_role;

REVOKE ALL ON public.payment_charge_locks FROM PUBLIC, anon, authenticated;

-- Verification (run on a branch/local database, never by inserting test
-- money in production):
--   SELECT proname, proacl FROM pg_proc WHERE proname LIKE 'stax_%';
--   SELECT indexdef FROM pg_indexes WHERE indexname LIKE 'payment_charge_locks_%';
--   SELECT has_function_privilege('authenticated',
--     'public.stax_finalize_charge(bigint)', 'EXECUTE'); -- false
