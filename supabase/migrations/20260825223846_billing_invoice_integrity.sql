-- ============================================================
-- BILLING INVOICE INTEGRITY
-- ============================================================
-- Requires: fs5_phase2_server_side_invoice_amount.sql,
--           billing_adjustments_model.sql,
--           policy_scoping_stage1_admin_predicate.sql
--
-- Makes the database calculation authoritative for every normal invoice
-- generation path and closes several ways a draft could become stale.
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'billing_invoices'
           AND column_name = 'invoice_type'
    ) OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'billing_invoices'
           AND column_name = 'sequence'
    ) THEN
        RAISE EXCEPTION 'Apply billing_adjustments_model.sql before billing invoice integrity';
    END IF;
END;
$$;


-- Price only care dates in the requested month, honor the room assigned to
-- each date, apply weekly rates, and apply per-child monthly overrides.
CREATE OR REPLACE FUNCTION public.compute_family_month_charges(
    p_family_id UUID,
    p_month     TEXT
) RETURNS TABLE (base NUMERIC(10,2), final NUMERIC(10,2))
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rates       jsonb;
    v_month_start date;
    v_month_end   date;
BEGIN
    IF p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
        RAISE EXCEPTION 'Invalid billing month: %', p_month;
    END IF;

    v_month_start := (p_month || '-01')::date;
    v_month_end   := (v_month_start + interval '1 month')::date;

    SELECT COALESCE(value::jsonb, '{}'::jsonb) INTO v_rates
      FROM settings WHERE key = 'room_rates';
    v_rates := COALESCE(v_rates, '{}'::jsonb);

    RETURN QUERY
    WITH fam AS (
        SELECT f.id,
               lower(trim(f.parent_email)) AS e1,
               lower(trim(COALESCE(f.parent2_email, ''))) AS e2
          FROM families f
         WHERE f.id = p_family_id
    ),
    fam_regs AS (
        SELECT r.id,
               r.child_name,
               lower(trim(r.child_name)) AS child_key,
               r.room_id
          FROM registrations r, fam
         WHERE r.status = 'confirmed'
           AND (lower(trim(r.parent_email)) = fam.e1
             OR (fam.e2 <> '' AND lower(trim(r.parent_email)) = fam.e2))
    ),
    day_rows AS (
        SELECT rd.care_date,
               fr.id AS reg_id,
               fr.child_name,
               fr.child_key,
               COALESCE(rd.room_id, fr.room_id) AS room_id,
               CASE WHEN rd.day_type = 'half' THEN 'half' ELSE 'full' END AS day_type,
               GREATEST(COALESCE(rd.change_fee, 0), 0)::numeric AS change_fee,
               date_trunc('week', rd.care_date)::date AS week_start
          FROM registration_dates rd
          JOIN fam_regs fr ON fr.id = rd.registration_id
         WHERE COALESCE(rd.waitlisted, false) = false
           AND rd.care_date >= v_month_start
           AND rd.care_date <  v_month_end
    ),
    rated AS (
        SELECT d.*,
               CASE WHEN d.day_type = 'half'
                    THEN COALESCE((v_rates -> d.room_id ->> 'halfDayRate')::numeric,
                                  (v_rates -> d.room_id ->> 'fullDayRate')::numeric,
                                  CASE d.room_id
                                      WHEN 'bear' THEN 80
                                      WHEN 'bee' THEN 55
                                      WHEN 'turtle' THEN 45
                                      WHEN 'goose' THEN 45
                                      WHEN 'owl' THEN 45
                                      WHEN 'summer' THEN 75
                                      ELSE 0 END)
                    ELSE COALESCE((v_rates -> d.room_id ->> 'fullDayRate')::numeric,
                                  CASE WHEN d.room_id = 'bear' THEN 80
                                       WHEN d.room_id IN ('bee','turtle','goose','owl','summer') THEN 75
                                       ELSE 0 END)
               END AS daily_rate,
               COALESCE(s.discount_type, 'none') AS discount_type,
               COALESCE(s.discount_value, 0)::numeric AS discount_value
          FROM day_rows d
          LEFT JOIN students s
            ON s.family_id = p_family_id
           AND lower(trim(s.child_name)) = d.child_key
    ),
    weekly_groups AS (
        SELECT r.child_key,
               r.week_start,
               min(r.room_id) AS room_id,
               min(r.day_type) AS day_type,
               CASE WHEN min(r.day_type) = 'half'
                    THEN (v_rates -> min(r.room_id) ->> 'weeklyHalfRate')::numeric
                    ELSE (v_rates -> min(r.room_id) ->> 'weeklyFullRate')::numeric
               END AS weekly_rate
          FROM rated r
         WHERE extract(isodow FROM r.care_date) BETWEEN 1 AND 5
         GROUP BY r.child_key, r.week_start
        HAVING count(DISTINCT r.care_date) = 5
           AND count(DISTINCT r.room_id) = 1
           AND count(DISTINCT r.day_type) = 1
    ),
    classified AS (
        SELECT r.*,
               wg.weekly_rate,
               (wg.weekly_rate IS NOT NULL) AS is_weekly,
               row_number() OVER (
                   PARTITION BY r.child_key, r.week_start
                   ORDER BY r.care_date, r.reg_id
               ) AS week_row
          FROM rated r
          LEFT JOIN weekly_groups wg
            ON wg.child_key = r.child_key
           AND wg.week_start = r.week_start
    ),
    daily_eff AS (
        SELECT c.*,
               CASE
                   WHEN c.discount_type = 'staff' THEN 0::numeric
                   WHEN c.discount_type = 'custom' AND c.discount_value > 0
                       THEN round(c.daily_rate * (1 - c.discount_value / 100.0), 2)
                   ELSE c.daily_rate
               END AS eff_rate,
               (c.discount_type = 'staff'
                OR (c.discount_type = 'custom' AND c.discount_value > 0)) AS has_indiv
          FROM classified c
         WHERE NOT c.is_weekly
    ),
    daily_ranked AS (
        SELECT d.*,
               count(*) OVER (PARTITION BY d.care_date) AS kids_that_day,
               bool_or(d.has_indiv) OVER (PARTITION BY d.care_date) AS any_indiv,
               row_number() OVER (
                   PARTITION BY d.care_date
                   ORDER BY d.eff_rate DESC, d.reg_id
               ) AS daily_rank
          FROM daily_eff d
    ),
    charge_rows AS (
        SELECT d.child_key,
               (d.daily_rate + d.change_fee)::numeric AS gross,
               (GREATEST(0, d.eff_rate - CASE
                    WHEN d.kids_that_day >= 2 AND NOT d.any_indiv AND d.daily_rank > 1
                    THEN 10 ELSE 0 END
                ) + d.change_fee)::numeric AS net
          FROM daily_ranked d
        UNION ALL
        SELECT c.child_key,
               ((CASE WHEN c.week_row = 1 THEN c.weekly_rate ELSE 0 END)
                   + c.change_fee)::numeric AS gross,
               ((CASE WHEN c.week_row <> 1 THEN 0
                      WHEN c.discount_type = 'staff' THEN 0
                      WHEN c.discount_type = 'custom' AND c.discount_value > 0
                          THEN round(c.weekly_rate * (1 - c.discount_value / 100.0), 2)
                      ELSE c.weekly_rate END)
                   + c.change_fee)::numeric AS net
          FROM classified c
         WHERE c.is_weekly
    ),
    child_totals AS (
        SELECT cr.child_key,
               sum(cr.gross)::numeric AS gross,
               sum(cr.net)::numeric AS net
          FROM charge_rows cr
         GROUP BY cr.child_key
    ),
    overrides AS (
        SELECT lower(trim(bo.child_name)) AS child_key,
               max(bo.override_amount)::numeric AS override_amount
          FROM billing_overrides bo, fam
         WHERE bo.month = p_month
           AND (lower(trim(bo.parent_email)) = fam.e1
             OR (fam.e2 <> '' AND lower(trim(bo.parent_email)) = fam.e2))
         GROUP BY lower(trim(bo.child_name))
    )
    SELECT round(COALESCE(sum(ct.gross), 0), 2)::numeric(10,2) AS base,
           round(COALESCE(sum(COALESCE(o.override_amount, ct.net)), 0), 2)::numeric(10,2) AS final
      FROM child_totals ct
      LEFT JOIN overrides o ON o.child_key = ct.child_key;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.compute_family_month_charges(UUID, TEXT) FROM PUBLIC, anon, authenticated;


-- Reconcile one family/month. Issued rows remain immutable; subsequent
-- differences become one reviewable draft adjustment.
CREATE OR REPLACE FUNCTION public._reconcile_billing_invoice_internal(
    p_family_id UUID,
    p_month     CHAR(7)
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

    -- Serialize changes for one family/month so simultaneous registration or
    -- admin actions cannot choose the same adjustment sequence number.
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
               AND status = 'draft';
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
        ON CONFLICT (cycle_id, family_id, sequence) DO UPDATE
            SET base_amount       = EXCLUDED.base_amount,
                discount_amount   = EXCLUDED.discount_amount,
                adjustment_amount = 0,
                adjustment_note   = '',
                final_amount      = EXCLUDED.final_amount
          WHERE billing_invoices.status = 'draft'
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
$$;

REVOKE EXECUTE ON FUNCTION public._reconcile_billing_invoice_internal(UUID, CHAR(7))
    FROM PUBLIC, anon, authenticated;

-- Authenticated admin entry point used by all normal admin invoice tools.
CREATE OR REPLACE FUNCTION public.reconcile_billing_invoice(
    p_family_id UUID, p_month CHAR(7)
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
    RETURN public._reconcile_billing_invoice_internal(p_family_id, p_month);
END;
$$;

-- Public registration can request a recomputation but cannot provide money.
CREATE OR REPLACE FUNCTION public.create_billing_invoice_by_email(
    p_email TEXT, p_month CHAR(7)
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_family_id uuid;
BEGIN
    SELECT id INTO v_family_id FROM families
     WHERE lower(trim(parent_email)) = lower(trim(p_email))
        OR lower(trim(COALESCE(parent2_email, ''))) = lower(trim(p_email))
     LIMIT 1;
    IF v_family_id IS NULL THEN RETURN NULL; END IF;
    RETURN public._reconcile_billing_invoice_internal(v_family_id, p_month);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_billing_invoice_by_email(TEXT, CHAR(7)) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_billing_invoice_by_email(TEXT, CHAR(7)) TO anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reconcile_billing_invoice(UUID, CHAR(7)) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_billing_invoice(UUID, CHAR(7)) TO authenticated;


-- Manual amounts and imported historical invoices use explicit, guarded
-- operations. Neither operation can rewrite an already-issued row.
CREATE OR REPLACE FUNCTION public.set_billing_invoice_draft_amount(
    p_family_id UUID, p_month CHAR(7), p_amount NUMERIC(10,2)
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_cycle_id bigint;
    v_id bigint;
BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
    IF p_amount < 0 THEN RAISE EXCEPTION 'Invoice amount cannot be negative'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_family_id::text || ':' || p_month, 0));
    INSERT INTO billing_cycles (month) VALUES (p_month) ON CONFLICT (month) DO NOTHING;
    SELECT id INTO v_cycle_id FROM billing_cycles WHERE month = p_month;
    IF EXISTS (SELECT 1 FROM billing_invoices WHERE cycle_id = v_cycle_id
        AND family_id = p_family_id AND status IN ('sent','finalized','paid','partial','void')) THEN
        RAISE EXCEPTION 'An issued invoice cannot be replaced; create an adjustment instead';
    END IF;
    INSERT INTO billing_invoices (cycle_id, family_id, base_amount, discount_amount,
        adjustment_amount, adjustment_note, final_amount, status, invoice_type, sequence)
    VALUES (v_cycle_id, p_family_id, p_amount, 0, 0, '', p_amount, 'draft', 'original', 1)
    ON CONFLICT (cycle_id, family_id, sequence) DO UPDATE
      SET base_amount = EXCLUDED.base_amount, discount_amount = 0,
          adjustment_amount = 0, adjustment_note = '', final_amount = EXCLUDED.final_amount
      WHERE billing_invoices.status = 'draft' AND billing_invoices.invoice_type = 'original'
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.import_finalized_billing_invoice(
    p_family_id UUID, p_month CHAR(7), p_amount NUMERIC(10,2)
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_cycle_id bigint;
    v_id bigint;
    v_existing_status text;
    v_existing_amount numeric(10,2);
BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
    IF p_amount < 0 THEN RAISE EXCEPTION 'Invoice amount cannot be negative'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_family_id::text || ':' || p_month, 0));
    INSERT INTO billing_cycles (month) VALUES (p_month) ON CONFLICT (month) DO NOTHING;
    SELECT id INTO v_cycle_id FROM billing_cycles WHERE month = p_month;
    SELECT id, status, final_amount
      INTO v_id, v_existing_status, v_existing_amount
      FROM billing_invoices
     WHERE cycle_id = v_cycle_id AND family_id = p_family_id AND sequence = 1;
    IF v_existing_status = 'finalized' AND v_existing_amount = p_amount THEN
        RETURN v_id; -- exact re-import is idempotent
    END IF;
    IF v_existing_status IN ('sent','finalized','paid','partial','void') THEN
        RAISE EXCEPTION 'Import would replace an existing issued invoice';
    END IF;
    INSERT INTO billing_invoices (cycle_id, family_id, base_amount, discount_amount,
        adjustment_amount, adjustment_note, final_amount, status, invoice_type, sequence)
    VALUES (v_cycle_id, p_family_id, p_amount, 0, 0, '', p_amount, 'finalized', 'original', 1)
    ON CONFLICT (cycle_id, family_id, sequence) DO UPDATE
      SET base_amount = EXCLUDED.base_amount, discount_amount = 0,
          adjustment_amount = 0, adjustment_note = '', final_amount = EXCLUDED.final_amount,
          status = 'finalized'
      WHERE billing_invoices.status = 'draft'
        AND billing_invoices.invoice_type = 'original'
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Import could not update the existing invoice'; END IF;
    RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_billing_invoice_draft_amount(UUID, CHAR(7), NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_billing_invoice_draft_amount(UUID, CHAR(7), NUMERIC) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.import_finalized_billing_invoice(UUID, CHAR(7), NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_finalized_billing_invoice(UUID, CHAR(7), NUMERIC) TO authenticated;
