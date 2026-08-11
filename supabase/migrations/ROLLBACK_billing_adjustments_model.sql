-- ============================================================
-- ROLLBACK — billing_adjustments_model.sql
-- ============================================================
-- Restores the pre-adjustment behaviour: one invoice per family per month,
-- recompute overwrites the draft, no adjustment documents.
--
-- ⚠️ Run step 1 FIRST. Any adjustment rows must be cleared before the
-- one-per-family-per-month constraint can be restored.
-- ============================================================

-- 1. Remove adjustment documents. Issued adjustments are real bills — check
--    before deleting. This deletes drafts only; issued ones must be handled
--    deliberately (void them, or keep them and skip this rollback).
DELETE FROM public.billing_invoices
 WHERE invoice_type = 'adjustment' AND status = 'draft';

-- Stop if any issued adjustments remain — restoring the constraint would fail
-- and, more importantly, those represent money already billed to a family.
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM public.billing_invoices WHERE invoice_type = 'adjustment';
    IF n > 0 THEN
        RAISE EXCEPTION 'ROLLBACK ABORTED: % issued adjustment invoice(s) exist. '
                        'These are bills a family has already been given. Void or '
                        'reconcile them deliberately before rolling back.', n;
    END IF;
END $$;

-- 2. Unfreeze the pre-system months.
UPDATE public.billing_invoices
   SET status = 'draft', reason = NULL
 WHERE status = 'void'
   AND reason LIKE 'Pre-system record%';

-- 3. Restore the single-invoice constraint.
DROP INDEX IF EXISTS public.billing_invoices_one_pending_draft;
ALTER TABLE public.billing_invoices
    DROP CONSTRAINT IF EXISTS billing_invoices_cycle_family_seq_key;
ALTER TABLE public.billing_invoices
    ADD  CONSTRAINT billing_invoices_cycle_id_family_id_key UNIQUE (cycle_id, family_id);

-- 4. Restore the non-branching recompute (the FS5 Phase 2 body).
CREATE OR REPLACE FUNCTION public.create_billing_invoice_by_email(
    p_email TEXT,
    p_month CHAR(7)
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_family_id  UUID;
    v_cycle_id   BIGINT;
    v_invoice_id BIGINT;
    v_base       NUMERIC(10,2);
    v_final      NUMERIC(10,2);
BEGIN
    SELECT id INTO v_family_id FROM families
    WHERE lower(parent_email) = lower(p_email) OR lower(parent2_email) = lower(p_email)
    LIMIT 1;
    IF v_family_id IS NULL THEN RETURN NULL; END IF;

    SELECT c.base, c.final INTO v_base, v_final
    FROM compute_family_month_charges(v_family_id, p_month) c;
    v_base  := GREATEST(COALESCE(v_base, 0), 0);
    v_final := GREATEST(COALESCE(v_final, 0), 0);

    IF v_final = 0 AND v_base = 0 THEN
        SELECT id INTO v_invoice_id FROM billing_invoices
         WHERE family_id = v_family_id
           AND cycle_id = (SELECT id FROM billing_cycles WHERE month = p_month);
        RETURN v_invoice_id;
    END IF;

    INSERT INTO billing_cycles (month) VALUES (p_month) ON CONFLICT (month) DO NOTHING;
    SELECT id INTO v_cycle_id FROM billing_cycles WHERE month = p_month;

    INSERT INTO billing_invoices (cycle_id, family_id, base_amount, discount_amount, final_amount, status)
    VALUES (v_cycle_id, v_family_id, v_base, GREATEST(v_base - v_final, 0), v_final, 'draft')
    ON CONFLICT (cycle_id, family_id) DO UPDATE
        SET base_amount = EXCLUDED.base_amount,
            discount_amount = EXCLUDED.discount_amount,
            final_amount = EXCLUDED.final_amount
        WHERE billing_invoices.status = 'draft'
    RETURNING id INTO v_invoice_id;

    IF v_invoice_id IS NULL THEN
        SELECT id INTO v_invoice_id FROM billing_invoices
         WHERE cycle_id = v_cycle_id AND family_id = v_family_id;
    END IF;
    RETURN v_invoice_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_billing_invoice_by_email(TEXT, CHAR(7)) TO anon, authenticated;

-- 5. Columns are left in place — they are additive and harmless. Drop only if
--    you are certain nothing reads them:
-- ALTER TABLE public.billing_invoices
--     DROP COLUMN invoice_type, DROP COLUMN sequence,
--     DROP COLUMN parent_invoice_id, DROP COLUMN reason;
