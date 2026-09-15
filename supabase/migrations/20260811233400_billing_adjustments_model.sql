-- ============================================================
-- BILLING ADJUSTMENTS — immutable invoices, reviewed adjustments
-- ============================================================
-- Design: docs/BILLING_MODEL.md (agreed with the director 2026-08-11).
--
-- An issued invoice records what the center TOLD a family they owe, so it is
-- never edited. Any later change to a child's days produces a separate
-- adjustment document, drafted for the director to review and issue.
--
--   adjustment = compute_family_month_charges(family, month).final
--              − SUM(final_amount) of everything already ISSUED for that
--                family and month
--
-- Positive is an extra charge, negative is a credit. This generalises
-- "compare against the first invoice" to work once there is more than one.
--
-- "Issued" already exists: markInvoicesSent() sets status='sent' + sent_at.
-- No new status is introduced here.
--
-- ROLLBACK: ROLLBACK_billing_adjustments_model.sql
-- ============================================================


-- ── 1. Columns ───────────────────────────────────────────────
ALTER TABLE public.billing_invoices
    ADD COLUMN IF NOT EXISTS invoice_type      text   NOT NULL DEFAULT 'original',
    ADD COLUMN IF NOT EXISTS sequence          int    NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS parent_invoice_id bigint REFERENCES public.billing_invoices(id),
    ADD COLUMN IF NOT EXISTS reason            text;

ALTER TABLE public.billing_invoices
    DROP CONSTRAINT IF EXISTS billing_invoices_invoice_type_check;
ALTER TABLE public.billing_invoices
    ADD  CONSTRAINT billing_invoices_invoice_type_check
         CHECK (invoice_type IN ('original', 'adjustment'));


-- ── 2. One invoice per family per month no longer holds ──────
-- Adjustments are siblings of the original, distinguished by sequence.
ALTER TABLE public.billing_invoices
    DROP CONSTRAINT IF EXISTS billing_invoices_cycle_id_family_id_key;
ALTER TABLE public.billing_invoices
    DROP CONSTRAINT IF EXISTS billing_invoices_cycle_family_seq_key;
ALTER TABLE public.billing_invoices
    ADD  CONSTRAINT billing_invoices_cycle_family_seq_key
         UNIQUE (cycle_id, family_id, sequence);

-- At most ONE pending draft adjustment per family per month. Repeated edits
-- update that row rather than spawning one per click, so the director reviews
-- one net adjustment instead of eleven.
DROP INDEX IF EXISTS billing_invoices_one_pending_draft;
CREATE UNIQUE INDEX billing_invoices_one_pending_draft
    ON public.billing_invoices (cycle_id, family_id)
    WHERE status = 'draft' AND invoice_type = 'adjustment';


-- ── 3. Freeze the pre-system months ──────────────────────────
-- Families were billed from Family Billing Summary, which recomputes live and
-- has been correct. These invoice rows were a side effect of registration and
-- then drifted; they are not what anyone was charged. Recomputing them would
-- re-bill closed months with facts that arrived later (+$5,250 for July alone).
--
-- `void` keeps the row and its amount but excludes it from balances, so nobody
-- mistakes these for collectible receivables. Reversible — see the rollback.
UPDATE public.billing_invoices bi
   SET status = 'void',
       reason = 'Pre-system record — billed outside the portal, frozen 2026-08-11'
  FROM public.billing_cycles bc
 WHERE bc.id = bi.cycle_id
   AND bc.month < '2026-08'
   AND bi.status = 'draft';


-- ── 4. The branch: original vs adjustment ────────────────────
CREATE OR REPLACE FUNCTION public.create_billing_invoice_by_email(
    p_email TEXT,
    p_month CHAR(7)
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_family_id    UUID;
    v_cycle_id     BIGINT;
    v_invoice_id   BIGINT;
    v_base         NUMERIC(10,2);
    v_final        NUMERIC(10,2);
    v_issued_count INT;
    v_baseline     NUMERIC(10,2);
    v_delta        NUMERIC(10,2);
    v_next_seq     INT;
BEGIN
    SELECT id INTO v_family_id
    FROM families
    WHERE lower(parent_email)  = lower(p_email)
       OR lower(parent2_email) = lower(p_email)
    LIMIT 1;

    IF v_family_id IS NULL THEN RETURN NULL; END IF;

    -- What the month SHOULD be, computed from registration data.
    SELECT c.base, c.final INTO v_base, v_final
    FROM compute_family_month_charges(v_family_id, p_month) c;
    v_base  := GREATEST(COALESCE(v_base, 0), 0);
    v_final := GREATEST(COALESCE(v_final, 0), 0);

    SELECT id INTO v_cycle_id FROM billing_cycles WHERE month = p_month;
    IF v_cycle_id IS NULL THEN
        IF v_final = 0 AND v_base = 0 THEN RETURN NULL; END IF;
        INSERT INTO billing_cycles (month) VALUES (p_month) ON CONFLICT (month) DO NOTHING;
        SELECT id INTO v_cycle_id FROM billing_cycles WHERE month = p_month;
    END IF;

    -- What has already been ISSUED. Drafts are not issued; void never counts.
    SELECT COUNT(*), COALESCE(SUM(final_amount), 0)
      INTO v_issued_count, v_baseline
      FROM billing_invoices
     WHERE cycle_id = v_cycle_id
       AND family_id = v_family_id
       AND status IN ('sent', 'paid', 'partial');

    -- ── Nothing issued yet: refresh the original draft, as before ──
    IF v_issued_count = 0 THEN
        IF v_final = 0 AND v_base = 0 THEN
            SELECT id INTO v_invoice_id FROM billing_invoices
             WHERE cycle_id = v_cycle_id AND family_id = v_family_id AND sequence = 1;
            RETURN v_invoice_id;
        END IF;

        INSERT INTO billing_invoices (cycle_id, family_id, base_amount, discount_amount,
                                      final_amount, status, invoice_type, sequence)
        VALUES (v_cycle_id, v_family_id, v_base, GREATEST(v_base - v_final, 0),
                v_final, 'draft', 'original', 1)
        ON CONFLICT (cycle_id, family_id, sequence) DO UPDATE
            SET base_amount     = EXCLUDED.base_amount,
                discount_amount = EXCLUDED.discount_amount,
                final_amount    = EXCLUDED.final_amount
            WHERE billing_invoices.status = 'draft'
        RETURNING id INTO v_invoice_id;

        IF v_invoice_id IS NULL THEN
            SELECT id INTO v_invoice_id FROM billing_invoices
             WHERE cycle_id = v_cycle_id AND family_id = v_family_id AND sequence = 1;
        END IF;
        RETURN v_invoice_id;
    END IF;

    -- ── Something is issued: never touch it, draft an adjustment ──
    v_delta := round(v_final - v_baseline, 2);

    -- The change cancelled out — withdraw any pending draft adjustment.
    IF v_delta = 0 THEN
        DELETE FROM billing_invoices
         WHERE cycle_id = v_cycle_id AND family_id = v_family_id
           AND status = 'draft' AND invoice_type = 'adjustment';
        RETURN NULL;
    END IF;

    -- Update the single pending draft if one is already waiting for review.
    SELECT id INTO v_invoice_id FROM billing_invoices
     WHERE cycle_id = v_cycle_id AND family_id = v_family_id
       AND status = 'draft' AND invoice_type = 'adjustment';

    IF v_invoice_id IS NOT NULL THEN
        UPDATE billing_invoices
           SET base_amount     = v_delta,
               discount_amount = 0,
               final_amount    = v_delta,
               reason          = 'Schedule changed after the invoice was issued'
         WHERE id = v_invoice_id;
        RETURN v_invoice_id;
    END IF;

    SELECT COALESCE(MAX(sequence), 0) + 1 INTO v_next_seq
      FROM billing_invoices WHERE cycle_id = v_cycle_id AND family_id = v_family_id;

    INSERT INTO billing_invoices (cycle_id, family_id, base_amount, discount_amount,
                                  final_amount, status, invoice_type, sequence,
                                  parent_invoice_id, reason)
    VALUES (v_cycle_id, v_family_id, v_delta, 0, v_delta, 'draft', 'adjustment', v_next_seq,
            (SELECT id FROM billing_invoices
              WHERE cycle_id = v_cycle_id AND family_id = v_family_id
                AND invoice_type = 'original' LIMIT 1),
            'Schedule changed after the invoice was issued')
    RETURNING id INTO v_invoice_id;

    RETURN v_invoice_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_billing_invoice_by_email(TEXT, CHAR(7)) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_billing_invoice_by_email(TEXT, CHAR(7)) TO anon, authenticated;


-- ── 5. Verification ──────────────────────────────────────────
-- (a) Pre-system months frozen, August onward untouched:
-- SELECT bc.month, bi.status, count(*) FROM billing_invoices bi
--   JOIN billing_cycles bc ON bc.id = bi.cycle_id GROUP BY 1,2 ORDER BY 1,2;
--
-- (b) Adjustment round trip on a test family: mark their August invoice sent,
--     change a day, and confirm a draft adjustment appears carrying only the
--     delta while the sent invoice is unchanged.
