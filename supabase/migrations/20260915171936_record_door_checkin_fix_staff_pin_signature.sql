-- ============================================================
-- Fix record_door_checkin: staff_id_for_pin takes NAME THEN PIN
-- ============================================================
-- APPLIED 2026-09-15 as version 20260915171936.
--
-- The first version (20260915171800) called staff_id_for_pin(p_pin) — one
-- argument. That is the signature in HISTORICAL_phase1_daily_feed_APPLIED
-- .sql, and it has not been the live signature for months:
-- staff_signin_name_then_pin replaced it with
-- staff_id_for_pin(p_staff_id uuid, p_pin integer), because a PIN alone was
-- guessable across the whole roster. The teacher picks their name first,
-- then enters the PIN — the same flow staff clock-in already uses.
--
-- ⚠️ THIS FAILED AT RUNTIME, NOT AT DEPLOY. `CREATE FUNCTION` happily
-- compiled a call to a function that does not exist; the error appeared only
-- when the function was actually invoked. It is the same trap log_child_event
-- records in its own header, and the reason the door RPC was called live
-- against production, as anon, before anything was wired to it.
--
-- It is also a second-order symptom of the ledger drift fixed in #403: the
-- repo's copy of that function was stale, so reading the repo gave the wrong
-- answer about the live schema. Read the database.
--
-- The old one-argument version is dropped rather than left beside the new
-- one: an overload that can never succeed is a loaded gun for whoever calls
-- it next.
--
-- ⚠️ THE KIOSK CONTRACT CHANGES WITH IT. The door tablet must collect the
-- teacher's NAME as well as their PIN. Nothing calls this yet, so no shipped
-- code breaks — but whatever wires it must pass both.
DROP FUNCTION IF EXISTS public.record_door_checkin(integer, text, text, text, text, date);

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
    -- 1. The teacher, not the parent: their name AND their PIN. Throttled
    --    inside staff_id_for_pin().
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

    -- A phone is the only way to find this family again tomorrow, and the
    -- only way to reach them if the child is still here at closing time.
    v_phone := regexp_replace(coalesce(p_guardian_phone, ''), '\D', '', 'g');
    IF length(v_phone) < 10 THEN
        RETURN jsonb_build_object('ok', false, 'code', 'missing_phone');
    END IF;

    v_date := coalesce(p_care_date, (now() AT TIME ZONE 'America/Chicago')::date);

    -- 2. The rate, read ONCE here and copied onto the charge. Never read
    --    back at invoice time — see decision 2 at the top of this file.
    -- ⚠️ settings.value is TEXT, not jsonb — the whole settings table is
    -- key/text, and every reader casts. `s.value->'programs'` looks right
    -- and fails at RUNTIME inside plpgsql, where nothing catches it at
    -- deploy time; the same trap log_child_event's header records.
    -- compute_family_month_charges_itemized casts the same way.
    -- Wrapped, because settings.value is admin-editable TEXT: a malformed
    -- document would raise inside the function and show a Postgres error on
    -- a wall tablet to a teacher holding a child. Fail closed instead — the
    -- kiosk already knows how to say "see the office" for no_rate, and
    -- refusing to charge is always safer than guessing a price.
    BEGIN
        SELECT (p->>'rate')::numeric INTO v_rate
          FROM settings s,
               jsonb_array_elements(
                   coalesce(s.value::jsonb -> 'programs', '[]'::jsonb)) p
         WHERE s.key = 'programs' AND p->>'id' = p_program_id;
    EXCEPTION WHEN others THEN
        v_rate := NULL;
    END;
    -- Also covers the case today: the `programs` settings row does not exist
    -- until someone saves Settings → Programs & add-ons once.
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

REVOKE ALL ON FUNCTION public.record_door_checkin(uuid, integer, text, text, text, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_door_checkin(uuid, integer, text, text, text, text, date)
    TO anon, authenticated;
