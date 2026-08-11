-- ============================================================
-- ROLLBACK — fs5_phase2_server_side_invoice_amount.sql
-- ============================================================
-- Restores the FS3 behaviour: create_billing_invoice_by_email takes the
-- amount from the caller again, additively, clamped >= 0, draft-only.
--
-- ⚠️ This reopens FS5: anon regains the ability to inflate any family's draft
-- invoice by an arbitrary amount. Acceptable ONLY while no payment processor
-- is attached. Do not leave the system in this state once cards are live.
--
-- Drop the 2-arg function FIRST — otherwise the 3-arg shim below still
-- delegates to it and nothing changes.
-- ============================================================

DROP FUNCTION IF EXISTS public.create_billing_invoice_by_email(TEXT, CHAR(7));
DROP FUNCTION IF EXISTS public.compute_family_month_charges(UUID, TEXT);

-- Restore the FS3 body verbatim.
CREATE OR REPLACE FUNCTION public.create_billing_invoice_by_email(
    p_email  TEXT,
    p_month  CHAR(7),
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
        RETURN NULL;
    END IF;

    INSERT INTO billing_cycles (month)
    VALUES (p_month)
    ON CONFLICT (month) DO NOTHING;

    SELECT id INTO v_cycle_id FROM billing_cycles WHERE month = p_month;

    INSERT INTO billing_invoices (cycle_id, family_id, base_amount, final_amount, status)
    VALUES (v_cycle_id, v_family_id, v_amount, v_amount, 'draft')
    ON CONFLICT (cycle_id, family_id) DO UPDATE
        SET base_amount  = billing_invoices.base_amount  + EXCLUDED.base_amount,
            final_amount = billing_invoices.final_amount + EXCLUDED.final_amount
        WHERE billing_invoices.status = 'draft'
    RETURNING id INTO v_invoice_id;

    IF v_invoice_id IS NULL THEN
        SELECT id INTO v_invoice_id
        FROM billing_invoices
        WHERE cycle_id = v_cycle_id AND family_id = v_family_id;
    END IF;

    RETURN v_invoice_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_billing_invoice_by_email(TEXT, CHAR(7), NUMERIC) TO anon, authenticated;

-- NOTE: the JS must be reverted too — js/supabase.js createInvoiceByEmail()
-- and its two callers (js/app.js, js/admin/admin-calendar.js) must pass the
-- amount again. Rebuild and commit dist/ after reverting.
