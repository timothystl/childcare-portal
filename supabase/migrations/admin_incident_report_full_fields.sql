-- ============================================================
-- admin_submit_incident_report gains the rest of the staff form's fields
-- ============================================================
-- The director's "+ Write a report" (Incident Reports tool) only ever wrote
-- five of the eleven fields the staff app's own incident form captures:
-- incident kind, description, action taken, location and body_area. Missing
-- were body_view/body_part (the specific mark), first_aid (what was done, as
-- chips), after_notes (the "since then" checklist), witnesses, and ratio_note
-- (staff-to-child ratio at the time — item 5 on the printed report, and what
-- licensing asks for). A report the director files herself printed a visibly
-- thinner record than one a teacher files, for no reason tied to who typed it.
--
-- This migration brings admin_submit_incident_report to parity with the live
-- submit_incident_report (17-arg, staff/PIN-gated, incident_three_signatures.sql
-- + incident_kind_and_after_notes.sql) — same six columns, same validation
-- (body_view constrained to front/back, NULL-safe array coalescing), same
-- INSERT list, minus only the PIN gate and the two staff-identity params that
-- make no sense from an authenticated admin session.
--
-- ⚠️ SAME ONE-FUNCTION RULE AS THE OTHER TWO INCIDENT MIGRATIONS. supabase-js
-- sends named parameters, so a 9-arg and a 15-arg admin_submit_incident_report
-- would both match a 9-named-argument call and PostgREST would refuse to pick
-- ("Could not choose the best candidate function"). DROP the old signature,
-- CREATE the new one, restate the grants — never CREATE OR REPLACE across a
-- changed argument list.

DROP FUNCTION IF EXISTS public.admin_submit_incident_report(
    uuid, text, text, text, text, text, text, timestamptz, text);

CREATE OR REPLACE FUNCTION public.admin_submit_incident_report(
    p_student_id    uuid,
    p_incident_type text,
    p_description   text,
    p_action_taken  text,
    p_incident_kind text        DEFAULT NULL,
    p_location      text        DEFAULT NULL,
    p_body_area     text        DEFAULT NULL,
    p_occurred_at   timestamptz DEFAULT NULL,
    p_signed_name   text        DEFAULT NULL,
    p_body_view     text        DEFAULT NULL,
    p_body_part     text        DEFAULT NULL,
    p_witnesses     text[]      DEFAULT NULL,
    p_first_aid     text[]      DEFAULT NULL,
    p_after_notes   text[]      DEFAULT NULL,
    p_ratio_note    text        DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
DECLARE v_at timestamptz; v_who text; v_id bigint;
BEGIN
    IF COALESCE(admin_role(), '') NOT IN ('full', 'restricted') THEN RETURN NULL; END IF;

    IF p_incident_type NOT IN ('injury', 'illness', 'behavior', 'other') THEN RETURN NULL; END IF;
    IF COALESCE(btrim(p_description), '') = '' OR COALESCE(btrim(p_action_taken), '') = '' THEN
        RETURN NULL;
    END IF;
    IF p_body_view IS NOT NULL AND p_body_view NOT IN ('front', 'back') THEN RETURN NULL; END IF;

    -- No back-date limit, matching submit_incident_report — only bound is
    -- never in the future.
    v_at  := LEAST(COALESCE(p_occurred_at, now()), now());
    v_who := COALESCE(nullif(btrim(p_signed_name), ''), auth.jwt() ->> 'email', 'Director');

    INSERT INTO incident_reports (
        student_id, care_date, occurred_at, filed_at, incident_type, incident_kind,
        location, body_area, body_view, body_part,
        description, action_taken, witnesses, first_aid, after_notes, ratio_note,
        reported_by_name, status
    ) VALUES (
        p_student_id, (v_at AT TIME ZONE 'America/Chicago')::date, v_at, now(),
        p_incident_type, nullif(btrim(p_incident_kind), ''),
        nullif(btrim(p_location), ''), nullif(btrim(p_body_area), ''),
        p_body_view, nullif(btrim(p_body_part), ''),
        btrim(p_description), btrim(p_action_taken),
        COALESCE(p_witnesses, '{}'), COALESCE(p_first_aid, '{}'), COALESCE(p_after_notes, '{}'),
        nullif(btrim(p_ratio_note), ''),
        v_who,
        'submitted'          -- never 'approved'; the print gate still needs all 3 signatures
    ) RETURNING id INTO v_id;

    -- Signature 1. She is filing it, so she is signing it — same rule as a
    -- teacher's own report. Unchanged from the original version of this
    -- function: the order-guard trigger on incident_signatures enforces
    -- everything after this exactly as it does for a staff-filed report.
    INSERT INTO incident_signatures (incident_id, role, signed_name)
    VALUES (v_id, 'teacher', v_who);

    RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_submit_incident_report(
    uuid, text, text, text, text, text, text, timestamptz, text,
    text, text, text[], text[], text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_submit_incident_report(
    uuid, text, text, text, text, text, text, timestamptz, text,
    text, text, text[], text[], text[], text) TO authenticated;

-- ============================================================
-- APPLIED AND VERIFIED IN PRODUCTION 2026-08-28
-- ============================================================
--   overloads of admin_submit_incident_report          1  (no ambiguity trap)
--   anon EXECUTE (15-arg signature)                    false
--   authenticated EXECUTE (15-arg signature)            true
--
-- Functional test, impersonating a real 'full'-role admin (dinger@timothystl.org
-- via settings.admin_roles) against a real student row: called with every new
-- field populated (body_view='front', body_part='Knee, left side',
-- witnesses=['Ms. Smith'], first_aid=['Cold pack','Comfort / rest'],
-- after_notes=['Back to playing within 5 minutes'], ratio_note set) and all
-- six landed on the inserted incident_reports row exactly as passed, alongside
-- the existing five fields and the signature-1 write. Test row (id 10) and its
-- signature were deleted immediately after reading them back — the live
-- catalog carries no trace of this test.
-- ============================================================
