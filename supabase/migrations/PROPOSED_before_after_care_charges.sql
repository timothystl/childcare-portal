-- ============================================================
-- PROPOSED — NOT APPLIED, NOT APPROVED
-- ============================================================
-- Before and after care charges. Design handoff: Capacity & Fill, turn 5.
--
-- ⚠️ READ THIS BEFORE RUNNING ANYTHING BELOW.
--
-- This file is a PROPOSAL. It is deliberately named PROPOSED_ rather than
-- with a version prefix so it cannot be mistaken for part of the applied
-- sequence and nothing tries to run it. See supabase/migrations/README.md.
--
-- Per AGENTS.md: migrations here are source records, applied by hand, and a
-- schema, RLS or data-ownership change on a live childcare system needs
-- Andrew's explicit approval for that specific operation. Nothing that ships
-- today depends on this table existing.
--
-- ── What this replaces, and why ─────────────────────────────
-- An earlier draft of this file proposed TWO tables: `program_enrolments`
-- and `program_attendance`. A child would be enrolled in a program the way
-- another child is enrolled in a room, and attendance would hang off that
-- enrolment.
--
-- Andrew corrected the premise: before and after care is NOT a room, and a
-- child is not enrolled in it. It is **a charge that is applied if a child
-- attends.** Nothing more.
--
-- That correction removes a whole table and everything that came with it —
-- start and end dates, a live-enrolment constraint, a cohort, a provisional
-- flag that had to be cleared before the record was "real." None of it was
-- describing the business. It was describing a room, because a room was the
-- only shape the schema already had.
--
-- What is left is the one fact that matters: this child was here on this
-- day, so this much is owed.
--
-- ── The three decisions baked in below ──────────────────────
-- 1. ONE TABLE, and it is a charge. Not a booking, not a roster, not an
--    enrolment. A row exists because a child attended; no row means no
--    attendance and nothing owed. There is no "billed versus booked" gap to
--    reconcile because there is no booking.
--
-- 2. THE RATE IS COPIED IN, not read back at invoice time. A rate change in
--    October must not silently re-price September. Same reasoning as
--    billing_payments recording its own amount rather than recomputing one,
--    and payroll_freeze_rate_per_period_and_ytd freezing a wage.
--
-- 3. NO ROOM, NO CAPACITY, NO WAITLIST — and this falls out for free rather
--    than needing to be enforced. Room capacity, the ratio math, the
--    waitlist allocation and the fill forecast all read `registrations` and
--    `registration_dates`. A Pre-K child who only turns up at 3:00 has a
--    `students` row and no registration, so every one of those screens
--    correctly never sees them. Nothing has to remember to exclude them.
--
-- ── Still to decide before this is worth applying ───────────
-- Andrew's correction settles the shape but not the billing route, and
-- these two are genuinely open:
--
--   * A Pre-K child has no registration, so who receives the invoice?
--     Either their family is a `families` row like any other and is billed
--     directly, or Timothy Lutheran Pre-K is billed once for all of them and
--     collects from its own families. The column `bill_to` is NOT included
--     below on purpose — guessing it into the schema would bake in an answer
--     nobody has given. Add it when the answer exists.
--
--   * A name taken at the door, before the office has a family record: is
--     that a `students` row created on the spot, or a note the office turns
--     into one later? A charge needs someone to bill, so this is the thing
--     that blocks the kiosk half of the design, not a detail.
-- ============================================================

BEGIN;

-- ── The charge ──────────────────────────────────────────────
-- One row per child per program per day. That row IS the charge.
CREATE TABLE IF NOT EXISTS public.care_charges (
    id            bigserial PRIMARY KEY,
    student_id    uuid        NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    -- A program id from settings.programs ('before_care', 'after_care').
    -- Deliberately TEXT and deliberately NOT a foreign key: programs are an
    -- admin-edited settings document, not a table, and an FK here would force
    -- that decision to be reversed.
    program_id    text        NOT NULL,
    care_date     date        NOT NULL,
    -- The rate AS CHARGED, copied when the row is written. See decision 2.
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

-- Month-end invoicing reads a date range; the daily screen reads one day.
CREATE INDEX IF NOT EXISTS care_charges_date_idx
    ON public.care_charges (care_date, program_id);
CREATE INDEX IF NOT EXISTS care_charges_student_idx
    ON public.care_charges (student_id, care_date DESC);

-- ── RLS ─────────────────────────────────────────────────────
-- ⚠️ The policy names its role explicitly. NOT `TO public` — the note in
-- HISTORICAL_phase1_daily_feed_APPLIED.sql explains why: `public` includes
-- `authenticated`, so a policy written that way is wider than it reads.
ALTER TABLE public.care_charges ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "admin any role" ON public.care_charges
        FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ⚠️ NO anon policy, and no parent policy, on purpose.
--
-- The door kiosk is not signed in as anybody: it authenticates a family with
-- family_login and holds no session. Giving it a direct INSERT would mean an
-- anon policy over a table naming children AND setting a dollar amount — the
-- R27 class of mistake this repo has already had once. The kiosk's write must
-- go through a SECURITY DEFINER RPC that verifies a STAFF pin (the teacher
-- taking the child in), the way log_child_event does. That RPC is
-- deliberately not written here: it is the next decision, not a detail.
--
-- A parent seeing their own child's charges would be a separate, narrower
-- policy keyed on the family behind student_id. Also not written here, for
-- the same reason.

COMMIT;

-- ── After applying, by hand ─────────────────────────────────
-- 1. Verify live schema state (AGENTS.md):  \d care_charges
-- 2. Check the anon role really cannot see it:
--      SET ROLE anon; SELECT * FROM care_charges;  -- must fail
--      RESET ROLE;
-- 3. Record the version the database assigns and rename this file to
--    <version>_before_after_care_charges.sql, then refresh the snapshot:
--      npm run migrations:snapshot < rows.tsv && npm run migrations:check
--    (supabase/migrations/README.md — never invent a timestamp.)
-- 4. Only then deploy code that reads it. Nothing does today.
