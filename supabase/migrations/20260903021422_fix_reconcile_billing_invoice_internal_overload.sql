-- The previous migration's CREATE OR REPLACE used `p_month text`, but the
-- existing function (and the reconcile_billing_invoice(uuid, character)
-- wrapper that calls it) used `p_month character`. Postgres treats those as
-- different types for overload resolution, so that CREATE OR REPLACE created
-- a SECOND function instead of replacing the original — the real invoice
-- path (which calls with a `character`-typed argument) kept resolving to the
-- OLD, unfixed function, so the annual-fee fix was not actually wired in.
-- Verified live before this fix: two overloads existed,
-- _reconcile_billing_invoice_internal(uuid,text) and (uuid,character).
drop function if exists public._reconcile_billing_invoice_internal(uuid, text);

create or replace function public._reconcile_billing_invoice_internal(p_family_id uuid, p_month character)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
    v_cycle_id     bigint;
    v_invoice_id   bigint;
    v_base         numeric(10,2);
    v_final        numeric(10,2);
    v_issued_count integer;
    v_baseline     numeric(10,2);
    v_delta        numeric(10,2);
    v_next_seq     integer;
    v_fee_reg      numeric;
    v_fee_new      numeric;
    v_fee_total    numeric;
    v_orig_fee     numeric;
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
        SELECT f.reg_fee, f.new_family_fee INTO v_fee_reg, v_fee_new
          FROM public._family_month_annual_fees(p_family_id, p_month) f;
        v_fee_total := COALESCE(v_fee_reg, 0) + COALESCE(v_fee_new, 0);
        v_base  := v_base  + v_fee_total;
        v_final := v_final + v_fee_total;

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
            status, invoice_type, sequence, annual_fee_amount
        ) VALUES (
            v_cycle_id, p_family_id, v_base, GREATEST(v_base - v_final, 0),
            0, '', v_final, 'draft', 'original', 1, v_fee_total
        )
        ON CONFLICT (cycle_id, family_id, sequence) DO UPDATE
            SET base_amount       = EXCLUDED.base_amount,
                discount_amount   = EXCLUDED.discount_amount,
                adjustment_amount = 0,
                adjustment_note   = '',
                final_amount      = EXCLUDED.final_amount,
                annual_fee_amount = EXCLUDED.annual_fee_amount,
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

    SELECT annual_fee_amount INTO v_orig_fee
      FROM billing_invoices
     WHERE cycle_id = v_cycle_id AND family_id = p_family_id AND invoice_type = 'original'
     ORDER BY sequence LIMIT 1;
    v_final := v_final + COALESCE(v_orig_fee, 0);

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
