-- ============================================================
-- APPLIED TO PRODUCTION 2026-09-15 — reconciling ledger drift
-- ============================================================
-- This version was applied by hand through the SQL Editor, superseding
-- supabase/migrations/PROPOSED_before_after_care_charges.sql, but the file
-- was never renamed to match and the ledger was never refreshed — the exact
-- drift supabase/migrations/README.md exists to catch. This file closes that
-- gap: it is a RECONSTRUCTION from live inspection (information_schema,
-- pg_constraint, pg_policies on project dahdstopsumxnqvdclmy) of what
-- `care_charges` actually looks like today, not a byte-for-byte replay of
-- the original SQL Editor statements, which were never committed. Per the
-- README's "ledger placeholder" guidance, this stands as the written record;
-- if it is ever re-run, every statement below is idempotent against the live
-- table, so it is a no-op rather than a redefinition.
--
-- The live table differs from the PROPOSED_ draft in exactly one way: it
-- carries its own `family_id`, not just `student_id`. That is also the
-- answer to the PROPOSED_ file's open "who receives the invoice" question —
-- settled directly with Andrew as "the child's own family in myMDO, billed
-- like any other family" — so the charge is billed by family_id straight off
-- this row, with no lookup through students needed to find who owes it.
--
-- One row per child per program per day. That row IS the charge.
CREATE TABLE IF NOT EXISTS public.care_charges (
    id            bigserial PRIMARY KEY,
    student_id    uuid        NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    -- Denormalized on purpose: the charge is owed by this family regardless
    -- of what students.family_id says later (a transfer must never rewrite
    -- who owed a past charge).
    family_id     uuid        NOT NULL REFERENCES public.families(id) ON DELETE RESTRICT,
    -- A program id from settings.programs ('before_care', 'after_care').
    -- Deliberately TEXT and deliberately NOT a foreign key: programs are an
    -- admin-edited settings document, not a table, and an FK here would force
    -- that decision to be reversed.
    program_id    text        NOT NULL,
    care_date     date        NOT NULL,
    -- The rate AS CHARGED, copied when the row is written. A price change in
    -- October must not silently re-price September.
    rate_charged  numeric(10,2) NOT NULL CHECK (rate_charged >= 0),
    -- A waived session stays on the invoice as a waived line with its reason,
    -- rather than vanishing. A charge that disappears is a charge nobody can
    -- ask about later.
    waived        boolean     NOT NULL DEFAULT false,
    waived_reason text,
    recorded_by   text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    -- A child cannot be charged for the same afternoon twice.
    CONSTRAINT care_charges_one_per_day
        UNIQUE (student_id, program_id, care_date),
    -- A waived charge has to say why. Otherwise "waived" becomes a silent
    -- discount nobody can account for at month end.
    CONSTRAINT care_charges_waived_needs_reason
        CHECK (NOT waived OR waived_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS care_charges_date_idx
    ON public.care_charges (care_date, program_id);
CREATE INDEX IF NOT EXISTS care_charges_student_idx
    ON public.care_charges (student_id, care_date DESC);
CREATE INDEX IF NOT EXISTS care_charges_family_idx
    ON public.care_charges (family_id, care_date DESC);

-- ── RLS ─────────────────────────────────────────────────────
-- ⚠️ The policy names its role explicitly. NOT `TO public` — `public`
-- includes `authenticated`, so a policy written that way is wider than it
-- reads (see HISTORICAL_phase1_daily_feed_APPLIED.sql).
ALTER TABLE public.care_charges ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "admin any role" ON public.care_charges
        FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- No anon policy and no parent policy, on purpose — see
-- 20260915171831_care_charges_strip_default_grants.sql for closing the
-- table-level grant this project's default privileges hand out to anon on
-- every new public table.
