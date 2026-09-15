-- ============================================================
-- FINANCE — exception tracking, nudges, payment plans, write-offs
-- ============================================================
-- Design handoff (`Finance.dc.html`): the director's job is who to bill, what
-- went out, who still owes. This migration adds the tables that back the
-- three new screens (1a Finance home, 1c Bill the month, 1e Who owes) without
-- touching the existing billing engine — `_buildFamilyBillingData()` in
-- admin-reports.js stays the single source of truth for what a family owes;
-- everything here is bookkeeping ON TOP of that number, never a second way to
-- compute it.
--
-- ⚠️ discount_expires_at is the only new column on an existing table. Every
-- other addition is a new table. In particular this does NOT touch
-- `discount_type`'s allowed values — it has never been a CHECK constraint (it
-- is free text, read by effectiveAdminRate() in admin-init.js), so a
-- 'scholarship' value needs no migration. Adding one here would have meant
-- touching the one function the business-logic test suite pins against
-- source-drift, for no reason: a scholarship's dollar effect is realized the
-- same way a staff/custom discount's already is (a % via discount_value, or an
-- exact $ via billing_overrides) — 'scholarship' only needs to be
-- *recognized*, for the expiry-tracking exception, not computed differently.

BEGIN;

ALTER TABLE public.students
    ADD COLUMN IF NOT EXISTS discount_expires_at date;
COMMENT ON COLUMN public.students.discount_expires_at IS
    'When set, "Bill the month" flags this child as an exception once the date is within about 6 weeks or past. Purely informational — does not change what effectiveAdminRate() charges.';

-- ── Credits ─────────────────────────────────────────────────
-- A standing credit on a family's account — a closure prorate, a goodwill
-- adjustment, anything entered by hand rather than computed. Distinct from a
-- write-off: a credit reduces what is owed going forward; a write-off forgives
-- what is already overdue.
CREATE TABLE IF NOT EXISTS public.billing_credits (
    id                 bigserial PRIMARY KEY,
    family_id          uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
    -- Positive dollars, always. `applied_invoice_id` tells you whether it has
    -- been used yet — there is no negative-amount convention to get backwards.
    amount             numeric(10,2) NOT NULL CHECK (amount > 0),
    reason             text NOT NULL,
    source             text NOT NULL DEFAULT 'manual'
                           CHECK (source IN ('closure', 'manual', 'other')),
    created_by         text NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    -- NULL until a "Bill the month" pass consumes it against a real invoice.
    applied_invoice_id bigint REFERENCES public.billing_invoices(id) ON DELETE SET NULL,
    applied_at         timestamptz
);

CREATE INDEX IF NOT EXISTS billing_credits_family_idx
    ON public.billing_credits (family_id) WHERE applied_invoice_id IS NULL;

-- ── Nudges ──────────────────────────────────────────────────
-- Every reminder about an unpaid balance writes a row here. "Nudged Jun 10,
-- 20, 30, Jul 10 · not opened" on the Who Owes screen reads straight off this
-- table — there is no separate audit log to keep in sync.
CREATE TABLE IF NOT EXISTS public.billing_nudges (
    id          bigserial PRIMARY KEY,
    family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
    invoice_id  bigint REFERENCES public.billing_invoices(id) ON DELETE SET NULL,
    -- "Nudges go to the parent app and email only — no phone calls, no SMS."
    channel     text NOT NULL CHECK (channel IN ('push', 'email', 'both')),
    sent_at     timestamptz NOT NULL DEFAULT now(),
    sent_by     text NOT NULL,
    opened_at   timestamptz
);

CREATE INDEX IF NOT EXISTS billing_nudges_family_idx ON public.billing_nudges (family_id, sent_at DESC);

-- ── Payment plans ───────────────────────────────────────────
-- "Write off and payment plan are director-only actions and post to the
-- bookkeeper's queue" — the queue is this table plus billing_write_offs,
-- both admin-authenticated same as every other billing table; nothing here
-- is anon-reachable.
CREATE TABLE IF NOT EXISTS public.billing_payment_plans (
    id           bigserial PRIMARY KEY,
    family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
    invoice_id   bigint REFERENCES public.billing_invoices(id) ON DELETE SET NULL,
    total_amount numeric(10,2) NOT NULL CHECK (total_amount > 0),
    -- [{due_date, amount}, ...] — small and fully described by the director
    -- when she sets the plan up; no recurrence engine.
    schedule     jsonb NOT NULL DEFAULT '[]'::jsonb,
    note         text,
    approved_by  text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    status       text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'completed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS billing_payment_plans_family_idx
    ON public.billing_payment_plans (family_id) WHERE status = 'active';

-- ── Write-offs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_write_offs (
    id          bigserial PRIMARY KEY,
    family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
    invoice_id  bigint REFERENCES public.billing_invoices(id) ON DELETE SET NULL,
    amount      numeric(10,2) NOT NULL CHECK (amount > 0),
    note        text NOT NULL,
    approved_by text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
-- No DELETE grant for anyone, matching billing_payments and every other
-- ledger table in this app: a write-off is a decision that happened, not a
-- draft to discard.

CREATE INDEX IF NOT EXISTS billing_write_offs_family_idx ON public.billing_write_offs (family_id);

-- ── RLS ─────────────────────────────────────────────────────
-- Matching the EXACT policy already on billing_cycles / billing_invoices /
-- billing_payments (add_billing_module.sql): "Auth access", FOR ALL TO
-- authenticated USING(true). Not gated by is_admin() at the table level,
-- because none of the existing billing tables are either — the whole Finance
-- tab is already gated client-side by AP_FULL_ONLY_TABS, and introducing a
-- stricter pattern for only these four tables would be a new convention for
-- no real gain (every authenticated admin session in this app is staff on
-- the roster; there is no untrusted "authenticated but not staff" caller).
-- What matters, and what IS enforced here: anon gets nothing.
ALTER TABLE public.billing_credits       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_nudges        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_payment_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_write_offs    ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth access" ON public.billing_credits
    FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Auth access" ON public.billing_nudges
    FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Auth access" ON public.billing_payment_plans
    FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Auth access" ON public.billing_write_offs
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- REVOKE is redundant with RLS having no anon policy, but explicit beats
-- implicit after the 2026-08-14 sweep found dead/forgotten grants on tables
-- everyone assumed were already closed.
REVOKE ALL ON public.billing_credits       FROM anon, PUBLIC;
REVOKE ALL ON public.billing_nudges        FROM anon, PUBLIC;
REVOKE ALL ON public.billing_payment_plans FROM anon, PUBLIC;
REVOKE ALL ON public.billing_write_offs    FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.billing_credits       TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.billing_nudges        TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.billing_payment_plans TO authenticated;
GRANT SELECT, INSERT          ON public.billing_write_offs   TO authenticated;

-- ⚠️ The GRANT lines above are not the whole story. Supabase's
-- ALTER DEFAULT PRIVILEGES hands a brand-new table's `authenticated` role
-- DELETE/UPDATE/TRUNCATE in addition to whatever the migration's own GRANT
-- asked for -- the same trap already documented against incident_signatures
-- and staff_injury_and_headcount. Verified present here too, on all four
-- tables, immediately after applying the block above. Strip it back down:
REVOKE DELETE, TRUNCATE         ON public.billing_credits       FROM authenticated;
REVOKE DELETE, TRUNCATE         ON public.billing_nudges        FROM authenticated;
REVOKE DELETE, TRUNCATE         ON public.billing_payment_plans FROM authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON public.billing_write_offs    FROM authenticated;

COMMIT;

-- ============================================================
-- VERIFIED AFTER APPLYING
-- ============================================================
--   anon  -> billing_credits SELECT                         false
--   anon  -> billing_write_offs INSERT                       false
--   authenticated -> billing_write_offs UPDATE/DELETE/TRUNCATE  false / false / false
--   authenticated -> billing_credits/nudges/payment_plans
--                    DELETE / TRUNCATE                        false / false
--   authenticated -> billing_credits INSERT                  true
--   authenticated -> billing_nudges INSERT                   true
--   authenticated -> billing_payment_plans INSERT             true
--
-- Measured directly with information_schema.role_table_grants, not assumed --
-- has_table_privilege alone is what looked clean the first time and wasn't.
