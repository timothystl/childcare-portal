-- ============================================================
-- FS5 Phase 2 — server-side invoice amounts (closes T1's amount half)
-- ============================================================
-- STATUS: not yet applied. Apply in the Supabase SQL Editor, THEN deploy the
-- matching JS. Ordering is safe in either direction — see "Deploy order".
--
-- WHAT WAS WRONG
-- --------------
-- create_billing_invoice_by_email(p_email, p_month, p_amount) is SECURITY
-- DEFINER, anon-executable, and took the invoice amount FROM THE BROWSER.
-- The p_email argument means the caller chooses whose invoice to write, so
-- with nothing but the public anon key and a parent's email address anyone
-- could inflate that family's draft invoice by an arbitrary amount.
--
-- FS3 already blunted this — the upsert is additive, clamps to >= 0, and only
-- touches `status = 'draft'` rows — so an invoice cannot be zeroed or lowered
-- through this path. Inflation remained, bounded only by the fact that no
-- payment processor is attached and an admin regenerate heals it.
--
-- That bound disappears the moment online payments ship: an inflated draft
-- stops being a wrong number on a screen and becomes a real card charged a
-- real inflated amount on the 1st, unattended, via autopay. Hence this is a
-- hard prerequisite for the billing phase, not a cleanup item.
--
-- THE FIX
-- -------
-- The amount is no longer an input. p_amount is ignored and the total is
-- recomputed inside the database from the registration data that already
-- exists at call time (app.js calls this immediately after submitRegistration
-- has inserted the registration and its registration_dates rows).
--
-- The browser can still lie about WHAT IT BOOKED — but that writes visible
-- registration rows subject to the FS1 unique index, not a silent number.
-- The billing ledger is no longer a client-writable field.
--
-- EXACTNESS
-- ---------
-- compute_family_month_charges() mirrors buildBillingBreakdown() /
-- getChildDayAmounts() / effectiveRate() in js/app.js:
--
--   * base rate per room from settings.room_rates, by day_type
--   * rooms with no halfDayRate (bear, summer) are full-day-only, so a 'half'
--     booking falls back to fullDayRate — matching the JS `fullDayOnly` branch
--   * individual discount: 'staff' -> 0; 'custom' -> rate * (1 - value/100)
--   * sibling discount: when 2+ of the family's children are booked on the
--     same date AND nobody that day has an individual discount, every child
--     except the highest-rate one gets $10 off (floored at 0)
--   * per-date change_fee added
--   * waitlisted dates excluded
--
-- Verified against production at time of writing: every room has
-- weeklyFullRate = weeklyHalfRate = NULL, so the JS weekly-rate path is
-- inactive and this computation is EXACT, not approximate.
--
--   ⚠️ IF A WEEKLY RATE IS EVER SET in Settings -> Rates, this function will
--   diverge from the JS (it bills those weeks daily, i.e. slightly high until
--   an admin regenerate). Implement the weekly branch here at the same time,
--   or the draft and the generated invoice will disagree.
--
-- Idempotence: the recomputation covers the family's WHOLE month, so the
-- upsert now SETS rather than ADDS. Calling it twice is a no-op, and a
-- family's second same-month registration (the case FS3 was written for) is
-- handled natively — the recompute simply includes both. This supersedes
-- FS3's additive semantics; FS3's clamp and draft-only guard are retained.
--
-- Admin "Generate Invoices" (_buildFamilyBillingData -> upsertBillingInvoice)
-- remains the authoritative reconciliation, and additionally applies
-- billing_overrides, which this function deliberately does not.
--
-- ⚠️ THIS CHANGES SOME EXISTING DRAFT AMOUNTS — read before applying
-- ---------------------------------------------------------------
-- Recomputing the whole month fixes a pre-existing bug: the sibling discount
-- was only ever applied WITHIN a single registration session. Two siblings
-- registered separately (two sessions, or one parent each) each looked like an
-- only child, so neither got the $10/day sibling discount, and the additive
-- upsert summed the two undiscounted totals.
--
-- Real example found in production while writing this (invoice 3843/3828 class,
-- 2026-09): two siblings, five shared half-days, booked in separate sessions.
--   stored:   (55 + 45) x 5 = $500   -- no sibling discount
--   computed: (55 + 35) x 5 = $450   -- $10/day off the lower-rate child
-- The family is currently over-billed $50. The recomputation corrects it.
--
-- So applying this WILL move some draft invoices, mostly DOWNWARD, and those
-- corrections are real money for real families. Run verification query (a)
-- below BEFORE applying and review the diff list with the director — the
-- adjustments are correct, but they should be seen, not discovered later.
-- Past months that are already settled are unaffected unless someone
-- regenerates them (this function only touches `status = 'draft'`).
--
-- DEPLOY ORDER
-- ------------
-- The old 3-argument signature is kept as a thin shim that ignores p_amount
-- and delegates, so old bundles calling create_billing_invoice_by_email with
-- three arguments keep working and simply get the server-computed total.
-- Migration-first and JS-first are therefore both safe.
--
-- ROLLBACK: ROLLBACK_fs5_phase2_server_side_invoice_amount.sql
-- ============================================================


-- ── 1. The billing computation ───────────────────────────────
-- Returns the family's total for a month: `base` pre-discount (gross),
-- `final` post-discount (what is owed). Both include per-date change fees.
CREATE OR REPLACE FUNCTION public.compute_family_month_charges(
    p_family_id UUID,
    p_month     TEXT           -- 'YYYY-MM'
) RETURNS TABLE (base NUMERIC(10,2), final NUMERIC(10,2))
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rates jsonb;
BEGIN
    SELECT COALESCE(value::jsonb, '{}'::jsonb) INTO v_rates
    FROM settings WHERE key = 'room_rates';
    v_rates := COALESCE(v_rates, '{}'::jsonb);

    RETURN QUERY
    WITH fam AS (
        SELECT f.id, lower(f.parent_email) AS e1, lower(COALESCE(f.parent2_email, '')) AS e2
        FROM families f WHERE f.id = p_family_id
    ),
    fam_regs AS (
        SELECT r.id, r.child_name, r.room_id
        FROM registrations r, fam
        WHERE r.month_key = p_month
          AND r.status    = 'confirmed'
          AND (lower(r.parent_email) = fam.e1
            OR (fam.e2 <> '' AND lower(r.parent_email) = fam.e2))
    ),
    day_rows AS (
        SELECT rd.care_date,
               fr.id                              AS reg_id,
               fr.child_name,
               COALESCE(rd.room_id, fr.room_id)   AS room_id,
               rd.day_type,
               GREATEST(COALESCE(rd.change_fee, 0), 0) AS change_fee
        FROM registration_dates rd
        JOIN fam_regs fr ON fr.id = rd.registration_id
        WHERE COALESCE(rd.waitlisted, false) = false
    ),
    rated AS (
        SELECT d.*,
               -- Rooms without a halfDayRate are full-day-only; a 'half'
               -- booking there bills at the full rate (JS `fullDayOnly`).
               CASE WHEN d.day_type = 'half'
                    THEN COALESCE((v_rates -> d.room_id ->> 'halfDayRate')::numeric,
                                  (v_rates -> d.room_id ->> 'fullDayRate')::numeric, 0)
                    ELSE COALESCE((v_rates -> d.room_id ->> 'fullDayRate')::numeric, 0)
               END AS base_rate,
               COALESCE(s.discount_type, 'none')   AS discount_type,
               COALESCE(s.discount_value, 0)       AS discount_value
        FROM day_rows d
        LEFT JOIN students s
               ON s.family_id = p_family_id
              AND lower(s.child_name) = lower(d.child_name)
    ),
    eff AS (
        SELECT r.*,
               CASE
                   WHEN r.discount_type = 'staff' THEN 0::numeric
                   WHEN r.discount_type = 'custom' AND r.discount_value > 0
                        THEN round(r.base_rate * (1 - r.discount_value / 100.0), 2)
                   ELSE r.base_rate
               END AS eff_rate,
               (r.discount_type = 'staff'
                OR (r.discount_type = 'custom' AND r.discount_value > 0)) AS has_indiv
        FROM rated r
    ),
    ranked AS (
        SELECT e.*,
               count(*)             OVER (PARTITION BY e.care_date) AS kids_that_day,
               bool_or(e.has_indiv) OVER (PARTITION BY e.care_date) AS any_indiv,
               row_number()         OVER (PARTITION BY e.care_date
                                          ORDER BY e.eff_rate DESC, e.reg_id) AS rnk
        FROM eff e
    )
    SELECT
        round(COALESCE(SUM(r.base_rate + r.change_fee), 0), 2)::NUMERIC(10,2),
        round(COALESCE(SUM(
            GREATEST(0, r.eff_rate - CASE
                WHEN r.kids_that_day >= 2 AND NOT r.any_indiv AND r.rnk > 1
                THEN 10 ELSE 0 END)
            + r.change_fee), 0), 2)::NUMERIC(10,2)
    FROM ranked r;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.compute_family_month_charges(UUID, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.compute_family_month_charges(UUID, TEXT) TO authenticated;


-- ── 2. create_billing_invoice_by_email — amount no longer an input ──
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
    SELECT id INTO v_family_id
    FROM families
    WHERE lower(parent_email)  = lower(p_email)
       OR lower(parent2_email) = lower(p_email)
    LIMIT 1;

    IF v_family_id IS NULL THEN
        RETURN NULL; -- family not found; invoice creation skipped
    END IF;

    -- The amount comes from the database, never from the caller.
    SELECT c.base, c.final INTO v_base, v_final
    FROM compute_family_month_charges(v_family_id, p_month) c;

    v_base  := GREATEST(COALESCE(v_base, 0), 0);
    v_final := GREATEST(COALESCE(v_final, 0), 0);

    -- Nothing booked yet -> nothing to invoice. Don't create an empty draft.
    IF v_final = 0 AND v_base = 0 THEN
        SELECT id INTO v_invoice_id
        FROM billing_invoices
        WHERE family_id = v_family_id
          AND cycle_id = (SELECT id FROM billing_cycles WHERE month = p_month);
        RETURN v_invoice_id;
    END IF;

    INSERT INTO billing_cycles (month)
    VALUES (p_month)
    ON CONFLICT (month) DO NOTHING;

    SELECT id INTO v_cycle_id FROM billing_cycles WHERE month = p_month;

    -- SET, not ADD: this is a full recomputation of the family's month, so it
    -- is idempotent and a second same-month registration is already included.
    INSERT INTO billing_invoices (cycle_id, family_id, base_amount, discount_amount, final_amount, status)
    VALUES (v_cycle_id, v_family_id, v_base, GREATEST(v_base - v_final, 0), v_final, 'draft')
    ON CONFLICT (cycle_id, family_id) DO UPDATE
        SET base_amount     = EXCLUDED.base_amount,
            discount_amount = EXCLUDED.discount_amount,
            final_amount    = EXCLUDED.final_amount
        WHERE billing_invoices.status = 'draft'
    RETURNING id INTO v_invoice_id;

    -- Conflict on a non-draft invoice: leave it alone, return its id.
    IF v_invoice_id IS NULL THEN
        SELECT id INTO v_invoice_id
        FROM billing_invoices
        WHERE cycle_id = v_cycle_id AND family_id = v_family_id;
    END IF;

    RETURN v_invoice_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_billing_invoice_by_email(TEXT, CHAR(7)) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_billing_invoice_by_email(TEXT, CHAR(7)) TO anon, authenticated;


-- ── 3. Backwards-compatible shim for the old 3-arg signature ──
-- Ignores p_amount. Lets an old cached bundle keep working (and get the
-- correct server-computed total) regardless of deploy order.
CREATE OR REPLACE FUNCTION public.create_billing_invoice_by_email(
    p_email  TEXT,
    p_month  CHAR(7),
    p_amount NUMERIC(10,2)     -- IGNORED — retained for signature compatibility
) RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT public.create_billing_invoice_by_email(p_email, p_month);
$$;

REVOKE EXECUTE ON FUNCTION public.create_billing_invoice_by_email(TEXT, CHAR(7), NUMERIC) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_billing_invoice_by_email(TEXT, CHAR(7), NUMERIC) TO anon, authenticated;


-- ── 4. Verification ──────────────────────────────────────────
-- (a) The computation agrees with the invoices admin already generated.
--     Expect zero rows, or only rows explained by a billing_override.
--
-- SELECT f.parent_email, bc.month, bi.final_amount AS generated, c.final AS computed
-- FROM billing_invoices bi
-- JOIN billing_cycles bc ON bc.id = bi.cycle_id
-- JOIN families f ON f.id = bi.family_id
-- CROSS JOIN LATERAL compute_family_month_charges(bi.family_id, bc.month) c
-- WHERE bi.status = 'draft'
--   AND abs(bi.final_amount - c.final) > 0.01
-- ORDER BY abs(bi.final_amount - c.final) DESC
-- LIMIT 50;
--
-- (b) The amount is no longer caller-controlled. As anon, passing a wild
--     amount to the shim must still produce the computed total:
--
-- SELECT create_billing_invoice_by_email('<a real parent email>', '2026-09', 999999);
-- -- then confirm final_amount equals compute_family_month_charges(...).final
--
-- (c) Smoke-test the parent registration flow end to end and confirm the
--     draft invoice matches the receipt total shown to the parent.
