-- ============================================================
-- PROPOSED — NOT APPLIED, NOT APPROVED
-- ============================================================
-- Turns a recorded care_charges row into money on an invoice, for the first
-- time, and closes a gap left open by 20260915171800/171831/171936: nothing
-- stops a full-day Goose/Turtle/Owl child from being charged for after care
-- they already paid for as part of tuition.
--
-- ⚠️ READ THIS BEFORE RUNNING ANYTHING BELOW.
--
-- Per AGENTS.md: a change to compute_family_month_charges() and
-- record_door_checkin() on a live childcare and payment system needs
-- Andrew's explicit approval for this specific operation, staged and
-- smoke-tested before it touches production.
--
-- ── The scenario this was built for ─────────────────────────
-- Goose, Turtle and Owl combine into one supervised group from 1:00p
-- (PM_COMBINED_ROOM_IDS in js/supabase.js). A child with a full-day booking
-- in one of those three rooms already paid for that 1:00-5:00 stretch as
-- part of full-day tuition — nothing extra is owed. From 3:00p, children
-- from the Pre-K school who are NOT in the MDO program join the same floor,
-- and THOSE children are the ones after care actually bills.
--
-- care_charges, the door kiosk (record_door_checkin) and the provisional-
-- family design are already live (20260915171800, 20260915171831,
-- 20260915171936) — "bill each family directly" is already answered there.
-- Two things are still missing, and this migration is exactly those two:
--
--   1. NOBODY BILLS IT YET. compute_family_month_charges() and its itemized
--      twin still only read `registrations`/`registration_dates`. Every
--      care_charges row recorded by the kiosk so far sits there unbilled —
--      the applied migration's own closing line still says so: "Only then
--      deploy code that reads it. Nothing does today."
--
--   2. NOTHING GUARDS THE KIOSK AGAINST THE EXACT SCENARIO THIS FEATURE
--      EXISTS TO PREVENT. record_door_checkin() takes whatever child name a
--      teacher types and writes a charge — it never checks whether that
--      child already has a full-day booking in the combined rooms that
--      date. Today that is latent, not harmful, because nothing bills the
--      row it creates; the moment (1) ships, it becomes a real double
--      charge on a family who already paid.
--
-- ── Where the exclusion lives, and why it lives twice ───────
-- record_door_checkin() below REFUSES to write a charge for a child who
-- already has a full-day PM_COMBINED_ROOM_IDS booking that date — the
-- teacher sees `already_full_day` immediately instead of a silent
-- double-bill three weeks later.
--
-- compute_family_month_charges() / _itemized() below apply the SAME
-- exclusion again, independently, when summing what a family owes. This is
-- deliberate, not redundant: the kiosk guard is a courtesy that can be
-- bypassed (a bug, a future caller, a row written some other way), but the
-- invoice total must be correct regardless of how a bad row got in. The
-- bill, not the kiosk, is the one place that has to be right — the same
-- reasoning AGENTS.md states plainly: "Never trust client-supplied ...
-- claims when the server can derive or re-read them."
--
-- A charge is always billed as its OWN itemized line ("<child> — After
-- care"), never blended into that child's tuition row, even for a child who
-- has both (e.g. a half-day MDO booking that stays for after care — a half
-- day goes home before the rooms combine, so that afternoon was never paid
-- for). A blended dollar figure next to "3 full days" would misstate what
-- the full-day rate actually buys.
-- ============================================================

-- ── compute_family_month_charges(): the real total a family owes ──
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
    ),
    -- Before/after care: a charge recorded because a child attended, never a
    -- booking. A student already covered by a full-day booking in the pooled
    -- afternoon rooms (PM_COMBINED_ROOM_IDS: goose, turtle, owl — must stay
    -- in sync with js/supabase.js) that same date is excluded here too, on
    -- top of record_door_checkin() refusing to create that row in the first
    -- place — see this file's header for why the check lives in both places.
    care_rows AS (
        SELECT cc.rate_charged
          FROM care_charges cc
          JOIN students s ON s.id = cc.student_id, fam
         WHERE cc.family_id = p_family_id
           AND cc.waived = false
           AND cc.care_date >= v_month_start
           AND cc.care_date <  v_month_end
           AND NOT EXISTS (
               SELECT 1
                 FROM registration_dates rd
                 JOIN registrations r ON r.id = rd.registration_id
                WHERE r.status = 'confirmed'
                  AND lower(trim(r.child_name)) = lower(trim(s.child_name))
                  AND (lower(trim(r.parent_email)) = fam.e1
                    OR (fam.e2 <> '' AND lower(trim(r.parent_email)) = fam.e2))
                  AND rd.care_date = cc.care_date
                  AND COALESCE(rd.waitlisted, false) = false
                  AND COALESCE(rd.day_type, 'full') = 'full'
                  AND COALESCE(rd.room_id, r.room_id) IN ('goose', 'turtle', 'owl')
           )
    ),
    care_totals AS (
        SELECT COALESCE(sum(cr.rate_charged), 0)::numeric AS total FROM care_rows cr
    )
    SELECT round(COALESCE(sum(ct.gross), 0) + (SELECT total FROM care_totals), 2)::numeric(10,2) AS base,
           round(COALESCE(sum(COALESCE(o.override_amount, ct.net)), 0) + (SELECT total FROM care_totals), 2)::numeric(10,2) AS final
      FROM child_totals ct
      LEFT JOIN overrides o ON o.child_key = ct.child_key;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.compute_family_month_charges(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- ── compute_family_month_charges_itemized(): same totals, per child ──
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
    ),
    -- Same charge population and same exclusion as
    -- compute_family_month_charges() above — see this file's header.
    care_rows AS (
        SELECT cc.rate_charged,
               lower(trim(s.child_name)) AS child_key,
               s.child_name
          FROM care_charges cc
          JOIN students s ON s.id = cc.student_id, fam
         WHERE cc.family_id = p_family_id
           AND cc.waived = false
           AND cc.care_date >= v_month_start
           AND cc.care_date <  v_month_end
           AND NOT EXISTS (
               SELECT 1
                 FROM registration_dates rd
                 JOIN registrations r ON r.id = rd.registration_id
                WHERE r.status = 'confirmed'
                  AND lower(trim(r.child_name)) = lower(trim(s.child_name))
                  AND (lower(trim(r.parent_email)) = fam.e1
                    OR (fam.e2 <> '' AND lower(trim(r.parent_email)) = fam.e2))
                  AND rd.care_date = cc.care_date
                  AND COALESCE(rd.waitlisted, false) = false
                  AND COALESCE(rd.day_type, 'full') = 'full'
                  AND COALESCE(rd.room_id, r.room_id) IN ('goose', 'turtle', 'owl')
           )
    ),
    -- Always its own line, even for a child who also has an MDO tuition row
    -- this month — see this file's header for why the two are never blended.
    care_child_totals AS (
        SELECT cr.child_key, min(cr.child_name) AS child_name,
               sum(cr.rate_charged)::numeric AS total
          FROM care_rows cr
         GROUP BY cr.child_key
    )
    (SELECT DISTINCT ON (ct.child_key)
           fr.child_name,
           COALESCE(dc.full_days, 0)::integer,
           COALESCE(dc.half_days, 0)::integer,
           round(COALESCE(ct.gross, 0), 2)::numeric(10,2),
           round(COALESCE(o.override_amount, ct.net, 0), 2)::numeric(10,2)
      FROM child_totals ct
      JOIN fam_regs fr ON fr.child_key = ct.child_key
      LEFT JOIN day_counts dc ON dc.child_key = ct.child_key
      LEFT JOIN overrides o ON o.child_key = ct.child_key
     ORDER BY ct.child_key, fr.id)
    UNION ALL
    (SELECT cct.child_name || ' — After care',
           0, 0,
           round(cct.total, 2)::numeric(10,2),
           round(cct.total, 2)::numeric(10,2)
      FROM care_child_totals cct);
END;
$function$;

REVOKE ALL ON FUNCTION compute_family_month_charges_itemized(uuid, text) FROM PUBLIC, anon, authenticated;

-- ── record_door_checkin(): guard against an already-covered full day ──
-- Same body as 20260915171936, plus one new refusal. Diff against that file
-- if reviewing: everything before "-- ⚠️ NEW:" is unchanged.
CREATE OR REPLACE FUNCTION public.record_door_checkin(
    p_staff_id      uuid,
    p_pin           integer,
    p_program_id    text,
    p_child_name    text,
    p_guardian_name text,
    p_guardian_phone text,
    p_care_date     date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $fn$
DECLARE
    PROVISIONAL_MAX_SESSIONS constant integer := 2;

    v_staff_id  uuid;
    v_date      date;
    v_phone     text;
    v_rate      numeric(10,2);
    v_family_id uuid;
    v_student_id uuid;
    v_used      integer;
    v_provisional boolean;
    v_already_full_day boolean;
BEGIN
    v_staff_id := staff_id_for_pin(p_staff_id, p_pin);
    IF v_staff_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'code', 'bad_pin');
    END IF;

    IF p_program_id NOT IN ('before_care', 'after_care') THEN
        RETURN jsonb_build_object('ok', false, 'code', 'bad_program');
    END IF;

    IF coalesce(btrim(p_child_name), '') = ''
       OR coalesce(btrim(p_guardian_name), '') = '' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'missing_name');
    END IF;

    v_phone := regexp_replace(coalesce(p_guardian_phone, ''), '\D', '', 'g');
    IF length(v_phone) < 10 THEN
        RETURN jsonb_build_object('ok', false, 'code', 'missing_phone');
    END IF;

    v_date := coalesce(p_care_date, (now() AT TIME ZONE 'America/Chicago')::date);

    BEGIN
        SELECT (p->>'rate')::numeric INTO v_rate
          FROM settings s,
               jsonb_array_elements(
                   coalesce(s.value::jsonb -> 'programs', '[]'::jsonb)) p
         WHERE s.key = 'programs' AND p->>'id' = p_program_id;
    EXCEPTION WHEN others THEN
        v_rate := NULL;
    END;
    IF v_rate IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'code', 'no_rate');
    END IF;

    SELECT id, provisional_at IS NOT NULL AND completed_at IS NULL
      INTO v_family_id, v_provisional
      FROM families
     WHERE regexp_replace(coalesce(parent_phone, ''), '\D', '', 'g') = v_phone
        OR regexp_replace(coalesce(parent2_phone, ''), '\D', '', 'g') = v_phone
     ORDER BY provisional_at NULLS FIRST
     LIMIT 1;

    IF v_family_id IS NULL THEN
        INSERT INTO families (parent_name, parent_phone, parent_email,
                              provisional_at, provisional_by)
        VALUES (btrim(p_guardian_name), btrim(p_guardian_phone), '',
                now(), v_staff_id)
        RETURNING id INTO v_family_id;
        v_provisional := true;
    END IF;

    IF v_provisional THEN
        SELECT count(*) INTO v_used FROM care_charges WHERE family_id = v_family_id;
        IF v_used >= PROVISIONAL_MAX_SESSIONS THEN
            RETURN jsonb_build_object(
                'ok', false, 'code', 'needs_office',
                'family_id', v_family_id, 'sessions_used', v_used);
        END IF;
    END IF;

    SELECT id INTO v_student_id
      FROM students
     WHERE family_id = v_family_id
       AND lower(btrim(child_name)) = lower(btrim(p_child_name))
     LIMIT 1;

    IF v_student_id IS NULL THEN
        INSERT INTO students (family_id, child_name, photo_release)
        VALUES (v_family_id, btrim(p_child_name), false)
        RETURNING id INTO v_student_id;
    END IF;

    -- ⚠️ NEW: a brand-new or still-provisional family cannot possibly have an
    -- existing MDO registration (it has no email yet), so this only ever
    -- fires for a REAL family the phone match found — exactly the case that
    -- matters: an existing MDO parent's child, already booked a full day in
    -- the combined rooms today, walking up to the same kiosk under
    -- after_care. Checked by name + the family's own email(s), the same key
    -- every registration match in this codebase uses, since a walk-in gives
    -- no registration_id to join on directly.
    IF p_program_id = 'after_care' AND NOT v_provisional THEN
        SELECT EXISTS (
            SELECT 1
              FROM families f
              JOIN registrations r
                ON lower(trim(r.parent_email)) = lower(trim(f.parent_email))
                OR (coalesce(f.parent2_email, '') <> ''
                    AND lower(trim(r.parent_email)) = lower(trim(f.parent2_email)))
              JOIN registration_dates rd ON rd.registration_id = r.id
             WHERE f.id = v_family_id
               AND r.status = 'confirmed'
               AND lower(trim(r.child_name)) = lower(trim(p_child_name))
               AND rd.care_date = v_date
               AND COALESCE(rd.waitlisted, false) = false
               AND COALESCE(rd.day_type, 'full') = 'full'
               -- PM_COMBINED_ROOM_IDS — must stay in sync with js/supabase.js
               AND COALESCE(rd.room_id, r.room_id) IN ('goose', 'turtle', 'owl')
        ) INTO v_already_full_day;
        IF v_already_full_day THEN
            RETURN jsonb_build_object(
                'ok', false, 'code', 'already_full_day',
                'family_id', v_family_id, 'student_id', v_student_id);
        END IF;
    END IF;

    INSERT INTO care_charges (student_id, family_id, program_id, care_date,
                              rate_charged, recorded_by)
    VALUES (v_student_id, v_family_id, p_program_id, v_date,
            v_rate, v_staff_id::text)
    ON CONFLICT (student_id, program_id, care_date) DO NOTHING;

    RETURN jsonb_build_object(
        'ok', true,
        'family_id', v_family_id,
        'student_id', v_student_id,
        'provisional', coalesce(v_provisional, false),
        'rate_charged', v_rate);
END;
$fn$;

REVOKE ALL ON FUNCTION public.record_door_checkin(uuid, integer, text, text, text, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_door_checkin(uuid, integer, text, text, text, text, date)
    TO anon, authenticated;

-- ============================================================
-- VERIFY (run after applying, before trusting a real invoice to it)
-- ============================================================
--   -- 1. A Pre-K-only family (no MDO registrations) with one after-care
--      charge this month bills exactly the program rate:
--   SELECT * FROM compute_family_month_charges('<prek_family_id>', '2026-09');
--   SELECT * FROM compute_family_month_charges_itemized('<prek_family_id>', '2026-09');
--
--   -- 2. A full-day Turtle/Goose/Owl child with a mistaken after-care charge
--      recorded for a day they were already booked full-day bills $0 extra
--      for that charge (the exclusion held) — confirm the itemized row for
--      "<child> — After care" is either absent or nets to 0 for that date.
--
--   -- 3. record_door_checkin() rejects the same scenario at the source:
--   SELECT record_door_checkin('<staff_id>', <pin>, 'after_care',
--       '<name of a child booked full-day today in goose/turtle/owl>',
--       '<that family''s guardian name>', '<that family''s phone>');
--   -- must return {"ok": false, "code": "already_full_day", ...}, not insert.
--
--   -- 4. anon still cannot touch care_charges directly, only through the RPC:
--   SET ROLE anon;
--   SELECT * FROM care_charges; -- must fail
--   RESET ROLE;
-- ============================================================
