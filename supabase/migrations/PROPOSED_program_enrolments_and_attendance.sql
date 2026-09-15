-- ============================================================
-- PROPOSED — NOT APPLIED, NOT APPROVED
-- ============================================================
-- Program enrolments and program attendance, for Before & After Care.
-- Design handoff: Capacity & Fill, turn 5 (5a–5d).
--
-- ⚠️ READ THIS BEFORE RUNNING ANYTHING BELOW.
--
-- This file is a PROPOSAL. It is deliberately named PROPOSED_ rather than
-- with a timestamp prefix so it cannot be mistaken for part of the applied
-- sequence, and so a "run everything in order" script skips it.
--
-- Per AGENTS.md: migrations in this folder are source records and are not
-- automatically applied; and schema, RLS and data-ownership changes on a
-- live childcare system need Andrew's explicit approval for that specific
-- operation. Nothing in the branch that introduced this file depends on
-- these tables existing — the Before & After Care screen reads the real
-- MDO afternoon and names this gap rather than querying a table that is
-- not there.
--
-- It exists so the decision is a review of concrete DDL rather than a
-- conversation about an idea.
--
-- ── The problem it solves ───────────────────────────────────
-- Timothy Lutheran Pre-K is a separate organization. Its children use
-- before and after care, never the MDO program. Today they cannot be
-- recorded at all: myMDO has rooms, and a room means capacity, a ratio, a
-- waitlist place and a line in the fill forecast — none of which is true
-- of a child who only turns up at 3:00.
--
-- ── The three decisions baked in below ──────────────────────
-- 1. A PROGRAM enrolment, not a room registration. This is what keeps
--    these children out of room capacity, the ratio math for a room, the
--    waitlist allocation and the fill forecast, while still counting them
--    in the program's own ratio during the program's own hours.
--
-- 2. NOTHING IS BOOKED AHEAD, so there is no schedule table. Attendance is
--    the only record, which means there is no "billed versus booked" gap
--    to reconcile — the invoice is a count of what happened. This is the
--    single most important thing in the file; adding a bookings table
--    later would recreate the reconciliation problem this avoids.
--
-- 3. A provisional record is a REAL child. A name taken at the door counts
--    in the ratio and produces a real invoice line, but stays visibly
--    unfinished until the office closes the file, and can only attend
--    twice before the kiosk asks for it to be cleared. It never quietly
--    becomes a complete record.
--
-- ── Still to decide before this is worth applying ───────────
--   * Does the Pre-K organization want ONE consolidated invoice, and to
--     collect from its own families itself? The handoff raises this and it
--     is unanswered. `program_enrolments.bill_to` below allows either, but
--     the billing code is not written, so the answer should come first.
--   * Who may clear a provisional record — any admin, or `full` only?
--     Written as any admin below; tighten if that is wrong.
-- ============================================================

BEGIN;

-- ── Enrolment: a child in a program, never in a room ────────
CREATE TABLE IF NOT EXISTS public.program_enrolments (
    id            bigserial PRIMARY KEY,
    -- A program id from settings.programs ('before_care', 'after_care',
    -- 'camp'). Deliberately TEXT and deliberately NOT a foreign key:
    -- programs are an admin-edited settings document, not a table, and
    -- making this an FK would force that decision to be reversed.
    program_id    text        NOT NULL,
    student_id    uuid        NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    -- 'mdo'   — a child already enrolled in a room, adding sessions
    -- 'prek'  — a child of the separate Pre-K organization
    -- 'guest' — anything else the office needs to record
    cohort        text        NOT NULL DEFAULT 'prek'
                  CHECK (cohort IN ('mdo', 'prek', 'guest')),
    -- Who gets the invoice. 'family' bills each family directly (the
    -- handoff's default); 'organization' bills Pre-K once and lets them
    -- collect. See the open decision at the top of this file.
    bill_to       text        NOT NULL DEFAULT 'family'
                  CHECK (bill_to IN ('family', 'organization')),
    -- A record taken at the door: real, billable, and visibly unfinished.
    provisional   boolean     NOT NULL DEFAULT false,
    -- Set when the office completes the file; NULL while provisional.
    cleared_at    timestamptz,
    cleared_by    text,
    started_on    date        NOT NULL DEFAULT current_date,
    ended_on      date,
    notes         text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    -- One live enrolment per child per program.
    CONSTRAINT program_enrolments_unique_live
        UNIQUE (program_id, student_id, started_on)
);

CREATE INDEX IF NOT EXISTS program_enrolments_program_idx
    ON public.program_enrolments (program_id) WHERE ended_on IS NULL;
CREATE INDEX IF NOT EXISTS program_enrolments_provisional_idx
    ON public.program_enrolments (provisional) WHERE provisional;

-- ── Attendance: the check-in IS the record ──────────────────
CREATE TABLE IF NOT EXISTS public.program_attendance (
    id            bigserial PRIMARY KEY,
    enrolment_id  bigint      NOT NULL REFERENCES public.program_enrolments(id) ON DELETE CASCADE,
    program_id    text        NOT NULL,
    care_date     date        NOT NULL,
    checked_in_at timestamptz NOT NULL DEFAULT now(),
    checked_out_at timestamptz,
    -- The rate AS CHARGED, copied at check-in. Not read back from
    -- settings.programs at invoice time: a rate change in October must not
    -- silently re-price September. Same reasoning as billing_payments
    -- recording its own amount rather than recomputing one.
    rate_charged  numeric(10,2) NOT NULL,
    -- A staff override records a reason and shows as a waived line on the
    -- invoice, rather than the session disappearing.
    waived        boolean     NOT NULL DEFAULT false,
    waived_reason text,
    recorded_by   text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    -- One session per child per program per day. A child cannot be checked
    -- into after care twice on the same afternoon.
    CONSTRAINT program_attendance_one_per_day
        UNIQUE (enrolment_id, program_id, care_date)
);

CREATE INDEX IF NOT EXISTS program_attendance_date_idx
    ON public.program_attendance (care_date, program_id);
CREATE INDEX IF NOT EXISTS program_attendance_enrolment_idx
    ON public.program_attendance (enrolment_id, care_date DESC);

-- ── RLS ─────────────────────────────────────────────────────
-- ⚠️ Every policy names its role explicitly. NOT `TO public` — the note in
-- phase1_daily_feed_APPLIED.sql explains why: `public` includes
-- `authenticated`, and a policy written that way is wider than it reads.
ALTER TABLE public.program_enrolments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.program_attendance  ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "admin any role" ON public.program_enrolments
        FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "admin any role" ON public.program_attendance
        FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ⚠️ NO anon policy, and no parent policy, on purpose.
--
-- The door kiosk is not signed in as anybody: it authenticates a family
-- with family_login and holds no session. Giving it a direct INSERT would
-- mean an anon policy over a table naming children — the R27 class of
-- mistake this repo has already had once. The kiosk's check-in must go
-- through a SECURITY DEFINER RPC that verifies a STAFF pin (the teacher
-- taking the child in), the same way log_child_event does, and that RPC is
-- deliberately not written here: it is the next decision, not a detail.
--
-- A parent seeing their own program attendance would be a separate,
-- narrower policy keyed on the family behind student_id. Also not written
-- here, for the same reason.

COMMIT;

-- ── After applying, by hand ─────────────────────────────────
-- 1. Verify live schema state (AGENTS.md): \d program_enrolments
-- 2. Check the anon role really cannot see either table:
--      SET ROLE anon; SELECT * FROM program_enrolments;  -- must fail
--      RESET ROLE;
-- 3. Only then deploy code that reads them. Nothing on the
--    design/capacity-and-fill branch does.
