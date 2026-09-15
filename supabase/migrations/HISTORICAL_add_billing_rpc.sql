-- Billing RPCs
-- Run in Supabase SQL Editor.
-- These functions use SECURITY DEFINER so the parent-facing app (anon key)
-- can create invoices and check balances without direct table access.

-- ── 1. create_billing_invoice_by_email ───────────────────────────────────────
-- Called when a parent or admin submits a registration.
-- Looks up the family UUID, ensures a billing_cycle exists for the month,
-- then upserts a billing_invoice.
-- Only updates the amount if the invoice is still in 'draft' status (never
-- overwrites a 'paid' or 'partial' invoice amount).
CREATE OR REPLACE FUNCTION create_billing_invoice_by_email(
    p_email  TEXT,
    p_month  CHAR(7),       -- 'YYYY-MM'
    p_amount NUMERIC(10,2)
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_family_id  UUID;
    v_cycle_id   BIGINT;
    v_invoice_id BIGINT;
BEGIN
    -- Look up family by primary or secondary email (case-insensitive)
    SELECT id INTO v_family_id
    FROM families
    WHERE lower(parent_email)  = lower(p_email)
       OR lower(parent2_email) = lower(p_email)
    LIMIT 1;

    IF v_family_id IS NULL THEN
        RETURN NULL; -- family not found; invoice creation skipped
    END IF;

    -- Ensure billing cycle exists for this month
    INSERT INTO billing_cycles (month)
    VALUES (p_month)
    ON CONFLICT (month) DO NOTHING;

    SELECT id INTO v_cycle_id FROM billing_cycles WHERE month = p_month;

    -- Upsert invoice: insert new, or update amount only when still draft
    INSERT INTO billing_invoices (cycle_id, family_id, base_amount, final_amount, status)
    VALUES (v_cycle_id, v_family_id, p_amount, p_amount, 'draft')
    ON CONFLICT (cycle_id, family_id) DO UPDATE
        SET base_amount  = EXCLUDED.base_amount,
            final_amount = EXCLUDED.final_amount
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

-- ── 2. add_day_to_invoice_by_email ────────────────────────────────────────────
-- Called when admin adds a care day to an existing registration.
-- Adds the day rate + change fee to the family's invoice for that month.
CREATE OR REPLACE FUNCTION add_day_to_invoice_by_email(
    p_email      TEXT,
    p_month      CHAR(7),
    p_day_amount NUMERIC(10,2),
    p_change_fee NUMERIC(10,2) DEFAULT 0
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_family_id  UUID;
    v_cycle_id   BIGINT;
    v_invoice_id BIGINT;
    v_delta      NUMERIC(10,2);
BEGIN
    v_delta := p_day_amount + p_change_fee;

    SELECT id INTO v_family_id
    FROM families
    WHERE lower(parent_email)  = lower(p_email)
       OR lower(parent2_email) = lower(p_email)
    LIMIT 1;

    IF v_family_id IS NULL THEN RETURN NULL; END IF;

    INSERT INTO billing_cycles (month)
    VALUES (p_month)
    ON CONFLICT (month) DO NOTHING;

    SELECT id INTO v_cycle_id FROM billing_cycles WHERE month = p_month;

    -- Update existing invoice, or create one if none exists yet
    INSERT INTO billing_invoices (cycle_id, family_id, base_amount, final_amount, status)
    VALUES (v_cycle_id, v_family_id, v_delta, v_delta, 'draft')
    ON CONFLICT (cycle_id, family_id) DO UPDATE
        SET base_amount  = billing_invoices.base_amount  + v_delta,
            final_amount = billing_invoices.final_amount + v_delta
    RETURNING id INTO v_invoice_id;

    IF v_invoice_id IS NULL THEN
        SELECT id INTO v_invoice_id
        FROM billing_invoices
        WHERE cycle_id = v_cycle_id AND family_id = v_family_id;
    END IF;

    RETURN v_invoice_id;
END;
$$;

-- ── 3. get_outstanding_balance_by_email ──────────────────────────────────────
-- Returns one row per month where the family has an unpaid balance.
-- Used by the parent registration page to show a balance warning.
CREATE OR REPLACE FUNCTION get_outstanding_balance_by_email(
    p_email TEXT
) RETURNS TABLE (
    billing_month  CHAR(7),
    final_amount   NUMERIC(10,2),
    amount_paid    NUMERIC(10,2),
    balance        NUMERIC(10,2)
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_family_id UUID;
BEGIN
    SELECT id INTO v_family_id
    FROM families
    WHERE lower(parent_email)  = lower(p_email)
       OR lower(parent2_email) = lower(p_email)
    LIMIT 1;

    IF v_family_id IS NULL THEN RETURN; END IF;

    RETURN QUERY
    SELECT
        bc.month                                           AS billing_month,
        bi.final_amount,
        COALESCE(SUM(bp.amount), 0)::NUMERIC(10,2)        AS amount_paid,
        (bi.final_amount - COALESCE(SUM(bp.amount), 0))::NUMERIC(10,2) AS balance
    FROM billing_invoices bi
    JOIN billing_cycles bc ON bc.id = bi.cycle_id
    LEFT JOIN billing_payments bp ON bp.invoice_id = bi.id
    WHERE bi.family_id = v_family_id
      AND bi.final_amount > 0
    GROUP BY bc.month, bi.final_amount
    HAVING (bi.final_amount - COALESCE(SUM(bp.amount), 0)) > 0
    ORDER BY bc.month;
END;
$$;

-- Grant execute to anon and authenticated roles so the parent portal can call these
GRANT EXECUTE ON FUNCTION create_billing_invoice_by_email(TEXT, CHAR(7), NUMERIC) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION add_day_to_invoice_by_email(TEXT, CHAR(7), NUMERIC, NUMERIC) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_outstanding_balance_by_email(TEXT) TO anon, authenticated;
