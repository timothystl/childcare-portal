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
-- start and end dates, a live-enrolment constraint, a cohort. None of it was
-- describing the business. It was describing a room, because a room was the
-- only shape the schema already had.
--
-- One idea from that draft survives, but moved and changed meaning. The old
-- "provisional" flag marked an ENROLMENT that was not yet real. It now marks
-- a FAMILY that exists but is unfinished — see the kiosk section below. The
-- difference matters: an unfinished family is a live billing record from the
-- moment it is written, which is a much sharper thing to get right.
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
-- ── ANSWERED: the kiosk creates a provisional family ────────
-- Andrew: "the kiosk creates a provisional family record at the door."
--
-- So a walk-in produces a real `families` row and a real `students` row on
-- the spot, and the charge has something to point at immediately. The
-- office completes the file afterwards.
--
-- ⚠️ THIS IS THE MOST DANGEROUS THING IN THIS FILE, and the reason the RPC
-- below is written the way it is. A wall tablet in a hallway, signed in as
-- nobody, would be creating a row in the table that BILLING, STATEMENTS,
-- BALANCES and PAYMENTS all read. The mitigations, each for a specific way
-- this goes wrong:
--
--   1. NO ANON WRITE, EVER. The kiosk calls one SECURITY DEFINER RPC that
--      verifies a STAFF PIN — the teacher taking the child in, not the
--      parent. `staff_id_for_pin()` already throttles internally (see
--      20260812210730_throttle_staff_pin_attempts.sql), so a PIN-guessing
--      loop from the hallway is already handled. No policy anywhere grants
--      anon anything.
--
--   2. A PROVISIONAL FAMILY IS VISIBLY UNFINISHED, not quietly normal.
--      `provisional_at` is NOT NULL until the office clears it. Without a
--      flag, a door-created family is indistinguishable from a real one and
--      differs only by having no email — which surfaces as an invoice that
--      silently goes nowhere, months later.
--
--   3. IT CANNOT ACCRUE FOREVER. After PROVISIONAL_MAX_SESSIONS charges the
--      RPC refuses and tells the kiosk to send the family to the office. A
--      provisional record is a bridge across one or two mornings, not a way
--      to be a customer indefinitely without ever giving the center an
--      email address.
--
--   4. IT CANNOT SPAWN A DUPLICATE EVERY MORNING. The same walk-in on
--      Tuesday must not create a second family, or the month splits across
--      two invoices and neither is right. The RPC matches an existing
--      provisional family on the guardian's normalized phone first.
--
--   5. TWO DEFAULTS ON THESE TABLES ARE WRONG FOR A DOOR RECORD, and both
--      are wrong in the direction that hurts a child rather than the
--      center, which is why they are handled explicitly below.
--
--      ALLERGIES ARE NOT "NONE", THEY ARE UNKNOWN. `students.allergies` is
--      NOT NULL and would default to an empty list, which reads exactly
--      like "reviewed, no allergies" — a claim nobody made, about a child
--      whose parent is walking out the door. The RPC leaves
--      `allergies_reviewed_at` NULL, which every existing allergy surface
--      already treats as unreviewed (student_allergies_reviewed_stamp.sql).
--
--      PHOTO RELEASE DEFAULTS TO TRUE, which is correct for a parent who
--      filled in an enrolment form and said yes. It is a consent nobody
--      gave when the child's name was typed at a door, so the RPC sets it
--      false and lets the office ask.
--
--      Neither of these is a billing property. They are the two places
--      where an unfinished record could quietly harm the child it describes.
--
-- ✔ ALREADY SAFE, checked rather than assumed: the new-family fee cannot
--   fire for a provisional family. Its gate in
--   20260910235429_annual_fee_single_month_gate.sql requires a CONFIRMED
--   REGISTRATION to establish the family's first care month, and a
--   provisional family has no registration, so the subquery is NULL and the
--   condition is false. A walk-in is not accidentally charged a joining fee.
--
-- ── ANSWERED: each family is billed directly ────────────────
-- Andrew: "bill each family directly, not the pre-k organization."
--
-- So there is no `bill_to` column, no organization payer, and no
-- consolidated Pre-K invoice. A Pre-K family is a `families` row like any
-- other and receives its own invoice, which means the whole existing
-- billing path — statements, balances, payments, the parent's billing tab —
-- works for them without a second mode to maintain.
--
-- ⚠️ That answer has one consequence worth building in rather than hoping
-- for. `students.family_id` is NULLABLE. A charge written against a student
-- with no family would be owed by nobody: it would never appear on an
-- invoice, never age into a balance, and never raise an error — it would
-- just sit there. So `care_charges` carries its OWN `family_id`, NOT NULL,
-- and an unbillable charge becomes impossible to write rather than
-- something a month-end report has to go looking for.
--
-- Storing it here rather than joining through `students` also freezes WHO
-- WAS BILLED, for the same reason `rate_charged` freezes the price: if a
-- child later moves between families, September's charge still belongs to
-- whoever owed it in September.
-- ============================================================

BEGIN;

-- ── The charge ──────────────────────────────────────────────
-- One row per child per program per day. That row IS the charge.
CREATE TABLE IF NOT EXISTS public.care_charges (
    id            bigserial PRIMARY KEY,
    student_id    uuid        NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    -- Who is billed, frozen at the moment the charge is written. NOT NULL,
    -- because `students.family_id` is nullable and a charge owed by nobody
    -- would never surface anywhere. See the note at the top of this file.
    --
    -- ON DELETE RESTRICT, not CASCADE: deleting a family must not silently
    -- erase what it was charged. The office settles or voids the charges
    -- first, deliberately.
    family_id     uuid        NOT NULL REFERENCES public.families(id) ON DELETE RESTRICT,
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
-- The month-end run is per family per month, so that is the index it needs.
CREATE INDEX IF NOT EXISTS care_charges_family_month_idx
    ON public.care_charges (family_id, care_date);

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

-- ── The provisional family, marked as such ──────────────────
-- Additive and nullable, so every existing row and every existing query is
-- unaffected: NULL provisional_at means an ordinary, complete family, which
-- is every row that exists today.
ALTER TABLE public.families
    ADD COLUMN IF NOT EXISTS provisional_at timestamptz,
    ADD COLUMN IF NOT EXISTS provisional_by uuid REFERENCES public.staff(id),
    ADD COLUMN IF NOT EXISTS completed_at   timestamptz,
    ADD COLUMN IF NOT EXISTS completed_by   text;

COMMENT ON COLUMN public.families.provisional_at IS
    'Set when this family was created at the door kiosk from a staff PIN. '
    'NULL means a complete, office-entered family. While set, the family has '
    'no email and no PIN: never email it, and show it as unfinished.';

-- One live provisional family per phone number, so the same walk-in on
-- Tuesday joins Monday's record instead of splitting the month across two
-- invoices. Partial, so it constrains nothing about real families.
CREATE UNIQUE INDEX IF NOT EXISTS families_provisional_one_per_phone
    ON public.families (regexp_replace(coalesce(parent_phone, ''), '\D', '', 'g'))
    WHERE provisional_at IS NOT NULL AND completed_at IS NULL;

-- The office's worklist: who still has to be turned into a real record.
CREATE INDEX IF NOT EXISTS families_provisional_open_idx
    ON public.families (provisional_at)
    WHERE provisional_at IS NOT NULL AND completed_at IS NULL;

-- ── The door check-in ───────────────────────────────────────
-- ONE entry point for the kiosk. It verifies a staff PIN, finds or creates
-- the provisional family and child, and writes the charge — atomically, so
-- a half-written walk-in cannot exist.
--
-- Returns a jsonb envelope rather than raising, because the caller is a wall
-- tablet held by someone with a child on one hip: every outcome has to be a
-- sentence a teacher can act on, not a Postgres error.
CREATE OR REPLACE FUNCTION public.record_door_checkin(
    p_pin           integer,
    p_program_id    text,
    p_child_name    text,
    p_guardian_name text,
    p_guardian_phone text,
    p_care_date     date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $fn$
DECLARE
    -- A bridge across a morning or two, not a way to stay a customer
    -- forever without ever giving the center an email address.
    PROVISIONAL_MAX_SESSIONS constant integer := 2;

    v_staff_id  uuid;
    v_date      date;
    v_phone     text;
    v_rate      numeric(10,2);
    v_family_id uuid;
    v_student_id uuid;
    v_used      integer;
    v_provisional boolean;
BEGIN
    -- 1. The teacher, not the parent. Throttled inside staff_id_for_pin().
    v_staff_id := staff_id_for_pin(p_pin);
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

    -- A phone is the only way to find this family again tomorrow, and the
    -- only way to reach them if the child is still here at closing time.
    v_phone := regexp_replace(coalesce(p_guardian_phone, ''), '\D', '', 'g');
    IF length(v_phone) < 10 THEN
        RETURN jsonb_build_object('ok', false, 'code', 'missing_phone');
    END IF;

    v_date := coalesce(p_care_date, (now() AT TIME ZONE 'America/Chicago')::date);

    -- 2. The rate, read ONCE here and copied onto the charge. Never read
    --    back at invoice time — see decision 2 at the top of this file.
    SELECT (p->>'rate')::numeric INTO v_rate
      FROM settings s,
           jsonb_array_elements(coalesce(s.value->'programs', '[]'::jsonb)) p
     WHERE s.key = 'programs' AND p->>'id' = p_program_id;
    IF v_rate IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'code', 'no_rate');
    END IF;

    -- 3. Find the family. A real, completed family first — a walk-in is
    --    often an existing MDO parent whose child is simply staying late,
    --    and billing them as a stranger would be wrong twice over.
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

    -- 4. The cap, counted across everything this provisional family has
    --    ever been charged — not per program and not per month, or it would
    --    reset its way into being permanent.
    IF v_provisional THEN
        SELECT count(*) INTO v_used FROM care_charges WHERE family_id = v_family_id;
        IF v_used >= PROVISIONAL_MAX_SESSIONS THEN
            RETURN jsonb_build_object(
                'ok', false, 'code', 'needs_office',
                'family_id', v_family_id, 'sessions_used', v_used);
        END IF;
    END IF;

    -- 5. The child. allergies_reviewed_at stays NULL on purpose: an empty
    --    allergy list here means UNKNOWN, not "reviewed, none". Every
    --    existing allergy surface already reads it that way.
    SELECT id INTO v_student_id
      FROM students
     WHERE family_id = v_family_id
       AND lower(btrim(child_name)) = lower(btrim(p_child_name))
     LIMIT 1;

    IF v_student_id IS NULL THEN
        -- ⚠️ photo_release DEFAULTS TO TRUE on this table, which is right for
        -- a child whose parent filled in an enrolment form and said so. It is
        -- wrong for a name typed at a door: that would grant a consent nobody
        -- gave, about someone else's child. Set false explicitly and let the
        -- office ask.
        INSERT INTO students (family_id, child_name, photo_release)
        VALUES (v_family_id, btrim(p_child_name), false)
        RETURNING id INTO v_student_id;
    END IF;

    -- 6. The charge. ON CONFLICT DO NOTHING because a teacher tapping the
    --    tile twice must not bill the family twice — the unique constraint
    --    is the guard, and a repeat tap is a no-op, not an error.
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

-- ⚠️ The kiosk holds no session, so `anon` is what actually calls this. That
-- is the ONLY thing anon may do here, and it may do it only by presenting a
-- staff PIN the function itself verifies. Nothing else is reachable: the
-- tables above carry admin-only policies and no anon grant.
REVOKE ALL ON FUNCTION public.record_door_checkin(integer, text, text, text, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_door_checkin(integer, text, text, text, text, date)
    TO anon, authenticated;

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
