-- ============================================================
-- ITEMIZED PER-CHILD BILLING BREAKDOWN
-- ============================================================
-- compute_family_month_charges() (fs5_phase2_server_side_invoice_amount.sql)
-- is the one place this app computes a family's real, discount-aware month
-- total server-side — it already builds a per-child subtotal internally
-- (the child_totals CTE) before summing everything into one (base, final)
-- row. This function is the SAME query, just returning that per-child row
-- instead of throwing it away — so an itemized invoice line for "Ellie: 12
-- full days" is guaranteed to add up to the exact number already being
-- charged, because it IS the same computation. No second copy of the rate/
-- discount/weekly-rate logic exists anywhere to drift from the real one.
--
-- Used by create-payment-session and create-stax-charge to build real line
-- items for the hosted-page / embedded-checkout "Order Summary" — see
-- CLAUDE.md's Stax/Anet sections for why a second, hand-rolled itemization
-- would have been the wrong call.

CREATE OR REPLACE FUNCTION compute_family_month_charges_itemized(p_family_id uuid, p_month text)
RETURNS TABLE(child_name text, full_days integer, half_days integer, gross numeric, net numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
        SELECT d.child_key, d.day_type,
               (d.daily_rate + d.change_fee)::numeric AS gross,
               (GREATEST(0, d.eff_rate - CASE
                    WHEN d.kids_that_day >= 2 AND NOT d.any_indiv AND d.daily_rank > 1
                    THEN 10 ELSE 0 END
                ) + d.change_fee)::numeric AS net
          FROM daily_ranked d
        UNION ALL
        SELECT c.child_key, c.day_type,
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
    day_counts AS (
        SELECT d.child_key,
               count(*) FILTER (WHERE d.day_type = 'full') AS full_days,
               count(*) FILTER (WHERE d.day_type = 'half') AS half_days
          FROM day_rows d
         GROUP BY d.child_key
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
    SELECT DISTINCT ON (ct.child_key)
           fr.child_name,
           COALESCE(dc.full_days, 0)::integer,
           COALESCE(dc.half_days, 0)::integer,
           round(COALESCE(ct.gross, 0), 2)::numeric(10,2),
           round(COALESCE(o.override_amount, ct.net, 0), 2)::numeric(10,2)
      FROM child_totals ct
      JOIN fam_regs fr ON fr.child_key = ct.child_key
      LEFT JOIN day_counts dc ON dc.child_key = ct.child_key
      LEFT JOIN overrides o ON o.child_key = ct.child_key
     ORDER BY ct.child_key, fr.id;
END;
$function$;

-- Same anon posture as compute_family_month_charges: never callable by
-- anon or PUBLIC. Only edge functions using the service role call this
-- (via admin.rpc), same as the existing function.
REVOKE ALL ON FUNCTION compute_family_month_charges_itemized(uuid, text) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- VERIFY (run after applying)
-- ============================================================
--   SELECT sum(net) FROM compute_family_month_charges_itemized('<family_id>', '2026-08');
--   -- should equal the `final` column of
--   SELECT * FROM compute_family_month_charges('<family_id>', '2026-08');
--   for the same family/month -- they share the identical CTE chain, so
--   this must always match exactly.
--
--   SELECT has_function_privilege('anon', 'compute_family_month_charges_itemized(uuid,text)', 'EXECUTE');
--   -> false
-- ============================================================
