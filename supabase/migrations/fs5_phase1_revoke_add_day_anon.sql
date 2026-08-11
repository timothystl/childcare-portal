-- ============================================================
-- FS5 Phase 1 — add_day_to_invoice_by_email: revoke anon/PUBLIC + clamp
-- ============================================================
-- STATUS: not yet applied. Apply in the Supabase SQL Editor.
--
-- This is the sharper half of FS5 and it is free to close.
--
-- WHAT WAS WRONG
-- --------------
-- add_day_to_invoice_by_email is SECURITY DEFINER and was granted EXECUTE to
-- BOTH anon and PUBLIC (`=X/postgres` in proacl). Its body:
--
--     v_delta := p_day_amount + p_change_fee;      -- no clamp
--     ...
--     ON CONFLICT (cycle_id, family_id) DO UPDATE
--         SET base_amount  = billing_invoices.base_amount  + v_delta,
--             final_amount = billing_invoices.final_amount + v_delta
--                                                  -- no status guard
--
-- Two independent defects on top of the anon grant:
--
--   1. NO CLAMP. p_day_amount and p_change_fee are taken verbatim, so a
--      negative delta is accepted. Anyone with the public anon key could
--      REDUCE or ZERO OUT a family's invoice, not merely inflate it.
--
--   2. NO STATUS GUARD. Unlike create_billing_invoice_by_email (which FS3
--      restricted to `WHERE status = 'draft'`), this updates an invoice in
--      ANY status — including `finalized` and `paid`. So the target was not
--      limited to provisional drafts; a settled invoice could be rewritten.
--
-- Combined: with nothing but the public key and a parent's email address, any
-- family's finalized invoice could be set to any value, including zero.
--
-- WHY THE REVOKE IS SAFE
-- ----------------------
-- The only caller is js/admin/admin-calendar.js:1042 (`_aadSubmit`, the admin
-- "Add a Day" modal), which runs on admin.html behind Supabase Auth — i.e. as
-- `authenticated`, never as `anon`.
--
-- Confirmed against production pg_stat_statements (complete since 2026-03-10
-- with zero evictions, so it covers this function's entire lifetime):
--
--     rolname       | calls | fn
--     --------------+-------+-----------------------------
--     authenticated |    30 | add_day_to_invoice_by_email
--
-- Zero anon calls. Ever. The anon and PUBLIC grants are pure attack surface.
--
-- NOTE ON PUBLIC: revoking from `anon` alone is NOT sufficient here. The ACL
-- shows `=X/postgres`, which is the PUBLIC grant — anon would still inherit
-- EXECUTE through it. Both must go. (Same trap as R26/R27.)
--
-- The clamp below is defence in depth: legitimate callers always pass a
-- positive day rate and a non-negative change fee, so GREATEST(...,0) cannot
-- affect the admin path. The status guard is deliberately NOT added — admin
-- legitimately adds a care day to a month whose invoice is already finalized,
-- and that must still adjust the amount owed.
--
-- ROLLBACK: ROLLBACK_fs5_phase1_revoke_add_day_anon.sql
-- ============================================================

-- ── 1. Clamp the delta ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.add_day_to_invoice_by_email(
    p_email      TEXT,
    p_month      CHAR(7),
    p_day_amount NUMERIC(10,2),
    p_change_fee NUMERIC(10,2) DEFAULT 0
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_family_id  UUID;
    v_cycle_id   BIGINT;
    v_invoice_id BIGINT;
    v_delta      NUMERIC(10,2);
BEGIN
    -- Never allow a negative adjustment through this path. Reducing an
    -- invoice is an admin correction and belongs in the billing UI, which
    -- writes billing_invoices directly as `authenticated`.
    v_delta := GREATEST(COALESCE(p_day_amount, 0), 0)
             + GREATEST(COALESCE(p_change_fee, 0), 0);

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

-- ── 2. Revoke from PUBLIC and anon ───────────────────────────
-- CREATE OR REPLACE preserves the existing ACL, so this must run after it.
REVOKE EXECUTE ON FUNCTION public.add_day_to_invoice_by_email(TEXT, CHAR(7), NUMERIC, NUMERIC)
    FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.add_day_to_invoice_by_email(TEXT, CHAR(7), NUMERIC, NUMERIC)
    TO authenticated;


-- ── 3. Verification — expect anon absent, authenticated present ──
-- SELECT proname, array_to_string(proacl, E'\n') AS acl
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public' AND proname = 'add_day_to_invoice_by_email';
--
-- Then smoke-test the admin "Add a Day" modal on admin.html and confirm the
-- invoice for that family/month increases by (day rate + change fee).
