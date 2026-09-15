-- ============================================================
-- FIX: reconcile_billing_invoice silently ignored a 'void' original invoice
-- ============================================================
-- Found live 2026-08-26 testing the new online-payments feature: a family's
-- only invoice row for the month was 'void' (created weeks earlier, then
-- voided). Generating drafts computed the correct current amount
-- ($50, from today's actual registration) for the on-screen preview, but
-- the WRITE path never touched the stored row, because the
-- `ON CONFLICT (cycle_id, family_id, sequence) DO UPDATE ... WHERE status =
-- 'draft'` clause only fires for a draft — a void row doesn't match, so
-- Postgres silently no-ops the update and the conflicting (void, stale)
-- row is returned untouched. The admin then emailed that stale row's old
-- $100 to the family, while the dashboard had been showing the correct $50
-- the whole time.
--
-- Fix: a void 'original' row is just as refreshable as a draft — it is not
-- an issued invoice (v_issued_count already correctly excludes 'void'), so
-- there is no reason recompute should skip writing to it. It also gets
-- explicitly revived to 'draft', since a row with a real, current amount
-- sitting in the void bucket ($0-owed by name, non-zero in fact) is exactly
-- the state this system's own invariants try to prevent elsewhere.

CREATE OR REPLACE FUNCTION public._reconcile_billing_invoice_internal(p_family_id uuid, p_month character)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_cycle_id     bigint;
    v_invoice_id   bigint;
    v_base         numeric(10,2);
    v_final        numeric(10,2);
    v_issued_count integer;
    v_baseline     numeric(10,2);
    v_delta        numeric(10,2);
    v_next_seq     integer;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM families WHERE id = p_family_id) THEN
        RETURN NULL;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_family_id::text || ':' || p_month, 0));

    SELECT c.base, c.final INTO v_base, v_final
      FROM public.compute_family_month_charges(p_family_id, p_month) c;
    v_base  := GREATEST(COALESCE(v_base, 0), 0);
    v_final := GREATEST(COALESCE(v_final, 0), 0);

    SELECT id INTO v_cycle_id FROM billing_cycles WHERE month = p_month;
    IF v_cycle_id IS NULL THEN
        IF v_base = 0 AND v_final = 0 THEN RETURN NULL; END IF;
        INSERT INTO billing_cycles (month) VALUES (p_month)
        ON CONFLICT (month) DO NOTHING;
        SELECT id INTO v_cycle_id FROM billing_cycles WHERE month = p_month;
    END IF;

    SELECT count(*), COALESCE(sum(final_amount), 0)
      INTO v_issued_count, v_baseline
      FROM billing_invoices
     WHERE cycle_id = v_cycle_id
       AND family_id = p_family_id
       AND status IN ('sent', 'finalized', 'paid', 'partial');

    IF v_issued_count = 0 THEN
        IF v_base = 0 AND v_final = 0 THEN
            DELETE FROM billing_invoices
             WHERE cycle_id = v_cycle_id
               AND family_id = p_family_id
               AND status IN ('draft', 'void');
            RETURN NULL;
        END IF;

        INSERT INTO billing_invoices (
            cycle_id, family_id, base_amount, discount_amount,
            adjustment_amount, adjustment_note, final_amount,
            status, invoice_type, sequence
        ) VALUES (
            v_cycle_id, p_family_id, v_base, GREATEST(v_base - v_final, 0),
            0, '', v_final, 'draft', 'original', 1
        )
        -- ⚠️ FIX: a 'void' original is just as stale-and-refreshable as a
        -- 'draft' one — it is not an issued invoice, so there is nothing to
        -- preserve by leaving it untouched. Reviving it to 'draft' here
        -- means a family that now has real billable days again gets a real
        -- draft instead of a permanently stuck void row with a live amount
        -- nobody can see or send.
        ON CONFLICT (cycle_id, family_id, sequence) DO UPDATE
            SET base_amount       = EXCLUDED.base_amount,
                discount_amount   = EXCLUDED.discount_amount,
                adjustment_amount = 0,
                adjustment_note   = '',
                final_amount      = EXCLUDED.final_amount,
                status            = 'draft'
          WHERE billing_invoices.status IN ('draft', 'void')
            AND billing_invoices.invoice_type = 'original'
        RETURNING id INTO v_invoice_id;

        IF v_invoice_id IS NULL THEN
            SELECT id INTO v_invoice_id
              FROM billing_invoices
             WHERE cycle_id = v_cycle_id
               AND family_id = p_family_id
               AND sequence = 1;
        END IF;
        RETURN v_invoice_id;
    END IF;

    v_delta := round(v_final - v_baseline, 2);
    IF v_delta = 0 THEN
        DELETE FROM billing_invoices
         WHERE cycle_id = v_cycle_id
           AND family_id = p_family_id
           AND status = 'draft'
           AND invoice_type = 'adjustment';
        RETURN NULL;
    END IF;

    SELECT id INTO v_invoice_id
      FROM billing_invoices
     WHERE cycle_id = v_cycle_id
       AND family_id = p_family_id
       AND status = 'draft'
       AND invoice_type = 'adjustment';

    IF v_invoice_id IS NOT NULL THEN
        UPDATE billing_invoices
           SET base_amount = v_delta,
               discount_amount = 0,
               adjustment_amount = 0,
               adjustment_note = '',
               final_amount = v_delta,
               reason = 'Schedule changed after the invoice was issued'
         WHERE id = v_invoice_id;
        RETURN v_invoice_id;
    END IF;

    SELECT COALESCE(max(sequence), 0) + 1 INTO v_next_seq
      FROM billing_invoices
     WHERE cycle_id = v_cycle_id AND family_id = p_family_id;

    INSERT INTO billing_invoices (
        cycle_id, family_id, base_amount, discount_amount,
        adjustment_amount, adjustment_note, final_amount,
        status, invoice_type, sequence, parent_invoice_id, reason
    ) VALUES (
        v_cycle_id, p_family_id, v_delta, 0, 0, '', v_delta,
        'draft', 'adjustment', v_next_seq,
        (SELECT id FROM billing_invoices
          WHERE cycle_id = v_cycle_id AND family_id = p_family_id
            AND invoice_type = 'original'
          ORDER BY sequence LIMIT 1),
        'Schedule changed after the invoice was issued'
    ) RETURNING id INTO v_invoice_id;

    RETURN v_invoice_id;
END;
$function$;

-- ============================================================
-- VERIFY (run after applying)
-- ============================================================
--   A family whose only original invoice for a month is 'void', with real
--   current billable days: call reconcile_billing_invoice(family_id, month)
--   as an admin -> the SAME row's status flips to 'draft' and its amounts
--   match compute_family_month_charges, rather than being returned
--   unchanged.
-- ============================================================
