-- ============================================================
-- Stax unapplied-credit guard: ignore imported (pre-portal) payment history
-- ============================================================
-- stax_quote_balance() (harden_stax_payments.sql) refuses online payment
-- whenever a family has ANY billing_payments row with invoice_id IS NULL,
-- on the theory that an unlinked payment means something went wrong and the
-- office needs to look at it before the family sends more money — see
-- docs/STAX_GO_LIVE.md §6's own note that this guard doesn't yet tell
-- "deliberate" apart from "something went wrong".
--
-- Every ProCare-imported payment row landed with invoice_id IS NULL by
-- construction: months billed and paid before this system went live have no
-- 'sent' invoice here to attach to (their local invoice rows are void/draft
-- placeholders), so the importer always left invoice_id blank. That is
-- reconciled history, not a live credit — but it trips the same guard as a
-- real unresolved balance. Verified live 2026-09-11: every one of the 659
-- unapplied billing_payments rows in production has import_batch_id set;
-- zero come from any other source. The pilot family that surfaced this
-- (Braxton Payne, family c91705eb-844a-4ba7-a2e7-af016e10352a) had exactly
-- $4,851.25 across 8 such rows, all payment_method='procare_payment',
-- blocking a $762.50 online payment for a month billed entirely in this
-- system.
--
-- Fix: only a payment recorded by THIS system's own live paths — never
-- carrying an import_batch_id — can trip the guard. charge-stax-payment's
-- own "balance changed mid-charge" unapplied-credit branch (see that
-- migration's v_remaining INSERT) never sets import_batch_id either, so that
-- real-time protection is unchanged; only import-batch residue is excluded.
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
     WHERE family_id = p_family_id
       AND invoice_id IS NULL
       AND import_batch_id IS NULL;
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
