-- ============================================================
-- FS3 — create_billing_invoice_by_email: additive draft upsert
-- ============================================================
-- Previously this RPC did ON CONFLICT DO UPDATE SET final_amount =
-- EXCLUDED.final_amount — it REPLACED a family's draft invoice with a single
-- registration session's total. A family's second same-month registration
-- (a later session, or the other parent registering separately) therefore
-- overwrote the first, silently under-billing.
--
-- This version ADDS to the existing draft invoice instead (matching
-- add_day_to_invoice_by_email's semantics). It also clamps the incoming
-- amount to >= 0 so a negative value can't be used to subtract from — or
-- zero out — a victim's invoice (relevant now that the upsert is additive;
-- also neutralizes the FS5 "zero out an invoice with the anon key" vector,
-- since adding 0 is a no-op). Non-draft (paid/partial) invoices are never
-- touched.
--
-- The admin "Generate Invoices" flow recomputes totals from registration
-- data via a separate direct-table path (upsertBillingInvoice), so it
-- remains the source-of-truth reconciliation for any additive drift.
-- ============================================================

CREATE OR REPLACE FUNCTION create_billing_invoice_by_email(
    p_email  TEXT,
    p_month  CHAR(7),       -- 'YYYY-MM'
    p_amount NUMERIC(10,2)
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_family_id  UUID;
    v_cycle_id   BIGINT;
    v_invoice_id BIGINT;
    v_amount     NUMERIC(10,2);
BEGIN
    v_amount := GREATEST(COALESCE(p_amount, 0), 0);

    SELECT id INTO v_family_id
    FROM families
    WHERE lower(parent_email)  = lower(p_email)
       OR lower(parent2_email) = lower(p_email)
    LIMIT 1;

    IF v_family_id IS NULL THEN
        RETURN NULL; -- family not found; invoice creation skipped
    END IF;

    INSERT INTO billing_cycles (month)
    VALUES (p_month)
    ON CONFLICT (month) DO NOTHING;

    SELECT id INTO v_cycle_id FROM billing_cycles WHERE month = p_month;

    -- Additive upsert: create the draft invoice, or add to an existing draft.
    INSERT INTO billing_invoices (cycle_id, family_id, base_amount, final_amount, status)
    VALUES (v_cycle_id, v_family_id, v_amount, v_amount, 'draft')
    ON CONFLICT (cycle_id, family_id) DO UPDATE
        SET base_amount  = billing_invoices.base_amount  + EXCLUDED.base_amount,
            final_amount = billing_invoices.final_amount + EXCLUDED.final_amount
        WHERE billing_invoices.status = 'draft'
    RETURNING id INTO v_invoice_id;

    -- If conflict and status was not draft, fetch existing id
    IF v_invoice_id IS NULL THEN
        SELECT id INTO v_invoice_id
        FROM billing_invoices
        WHERE cycle_id = v_cycle_id AND family_id = v_family_id;
    END IF;

    RETURN v_invoice_id;
END;
$$;

GRANT EXECUTE ON FUNCTION create_billing_invoice_by_email(TEXT, CHAR(7), NUMERIC) TO anon, authenticated;
