-- ============================================================
-- Incident report addenda — adding to a report without rewriting it
-- ============================================================
-- Raised directly: the director filed a report herself through "+ Write a
-- report" (admin_submit_incident_report) and needed to add something after
-- saving — a witness she forgot, a follow-up detail — and the drawer offered
-- no way to. That is by design at the SIGNATURE level: incident_signatures
-- rows are append-only (incident_three_signatures.sql's
-- incident_signature_immutable trigger), and the comment on that migration is
-- explicit — "correcting a report means the director returns it and the
-- teacher files again." What was missing is a way to add information that
-- does not touch anything already signed.
--
-- ⚠️ THIS IS DELIBERATELY NOT AN EDIT PATH. incident_reports itself has no
-- UPDATE RPC and gets none here. Rewriting `description`/`action_taken`/etc.
-- after a signature exists would mean a signed record's content could differ
-- from what was signed — exactly the failure the append-only signature
-- trigger exists to prevent. An addendum is a new, separately timestamped and
-- attributed row that supplements the record; the original filing is never
-- touched. This mirrors how a real incident/licensing record is corrected: by
-- adding a dated note, not by editing history.
--
-- Works at any stage — before any other signature, after the parent has
-- signed, even after the director has closed the record — because it never
-- conflicts with the signature order-guard (it inserts into a different
-- table entirely) and there is nothing about "the record is closed" that
-- should stop the office from adding a clarifying note to it later.

CREATE TABLE IF NOT EXISTS public.incident_report_addenda (
    id            bigserial PRIMARY KEY,
    incident_id   bigint NOT NULL REFERENCES public.incident_reports(id) ON DELETE RESTRICT,
    note          text NOT NULL CHECK (btrim(note) <> ''),
    added_by_name text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
-- ON DELETE RESTRICT, matching incident_reports/incident_signatures: an
-- addendum is evidence and does not get swept along behind something else's
-- deletion (and incident_reports itself has no DELETE grant regardless).

CREATE INDEX IF NOT EXISTS incident_report_addenda_incident_idx
    ON public.incident_report_addenda (incident_id, created_at);

-- Append-only, same rule and same shape as incident_signature_immutable().
CREATE OR REPLACE FUNCTION public.incident_addendum_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
    RAISE EXCEPTION 'incident addenda are append-only'
        USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS incident_addendum_no_update ON public.incident_report_addenda;
CREATE TRIGGER incident_addendum_no_update
    BEFORE UPDATE ON public.incident_report_addenda
    FOR EACH ROW EXECUTE FUNCTION public.incident_addendum_immutable();

-- ── Write path — admin only, same tier as filing itself ─────
-- Gated on admin_role() IN ('full','restricted'), not is_admin() alone — same
-- reasoning as admin_submit_incident_report: the 'staff' admin-portal role is
-- documented as read-only, and adding to an incident record is a write.
CREATE OR REPLACE FUNCTION public.admin_add_incident_addendum(
    p_incident_id bigint,
    p_note        text
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
DECLARE v_who text; v_id bigint;
BEGIN
    IF COALESCE(admin_role(), '') NOT IN ('full', 'restricted') THEN RETURN NULL; END IF;
    IF COALESCE(btrim(p_note), '') = '' THEN RETURN NULL; END IF;
    IF NOT EXISTS (SELECT 1 FROM incident_reports WHERE id = p_incident_id) THEN RETURN NULL; END IF;

    v_who := COALESCE(auth.jwt() ->> 'email', 'Director');

    INSERT INTO incident_report_addenda (incident_id, note, added_by_name)
    VALUES (p_incident_id, btrim(p_note), v_who)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_add_incident_addendum(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_add_incident_addendum(bigint, text) TO authenticated;

-- ── Grants and RLS — same shape as incident_signatures ───────
ALTER TABLE public.incident_report_addenda ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.incident_report_addenda FROM anon, PUBLIC;
GRANT SELECT ON public.incident_report_addenda TO authenticated;
-- Supabase's default privileges hand a new public table INSERT/UPDATE/DELETE
-- to `authenticated` — the exact dead-grant trap NEW-1/SX1 elsewhere in this
-- schema went looking for. Every write goes through the definer RPC above,
-- which is what makes "append-only" actually true rather than merely policed
-- by a trigger a direct INSERT could still hit.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON public.incident_report_addenda FROM authenticated, anon, PUBLIC;

CREATE POLICY "admin any role" ON public.incident_report_addenda
    FOR SELECT TO authenticated USING (is_admin());

-- Same condition as "parent read own approved" on incident_reports — an
-- addendum on a report the family cannot read yet is invisible until the
-- report itself publishes.
CREATE POLICY "parent read own approved" ON public.incident_report_addenda
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM incident_reports r
                   WHERE r.id = incident_id
                     AND r.status = 'approved'
                     AND parent_owns_student(r.student_id)));

-- ── incident_print_record() gains the addenda ────────────────
-- An addendum the director added must show up on the document that actually
-- leaves the building — omitting it from the printed/licensing copy would
-- mean the office UI and the record on paper could disagree about what is
-- known. Same signature, so CREATE OR REPLACE is safe here (no drop needed).
CREATE OR REPLACE FUNCTION public.incident_print_record(p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_row incident_reports; v_out jsonb;
BEGIN
    SELECT * INTO v_row FROM incident_reports WHERE id = p_id;
    IF NOT FOUND THEN RETURN NULL; END IF;

    IF NOT (is_admin() OR parent_owns_student(v_row.student_id)) THEN
        RETURN NULL;
    END IF;

    IF NOT incident_is_complete(p_id) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'incomplete',
            'have', (SELECT COALESCE(jsonb_agg(role ORDER BY incident_sig_ordinal(role)), '[]'::jsonb)
                     FROM incident_signatures WHERE incident_id = p_id));
    END IF;

    SELECT jsonb_build_object(
        'ok', true,
        'report', to_jsonb(v_row),
        'child', (SELECT jsonb_build_object('child_name', s.child_name, 'child_dob', s.child_dob,
                                            'room_id', COALESCE(s.room_override, ''))
                  FROM students s WHERE s.id = v_row.student_id),
        'signatures', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                            'role', g.role, 'signed_name', g.signed_name,
                            'signed_at', g.signed_at, 'on_device_of', g.signed_on_device_of)
                          ORDER BY incident_sig_ordinal(g.role)), '[]'::jsonb)
                       FROM incident_signatures g WHERE g.incident_id = p_id),
        'addenda', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                            'note', a.note, 'added_by_name', a.added_by_name,
                            'created_at', a.created_at)
                          ORDER BY a.created_at), '[]'::jsonb)
                    FROM incident_report_addenda a WHERE a.incident_id = p_id),
        'completed_at', (SELECT max(signed_at) FROM incident_signatures WHERE incident_id = p_id)
    ) INTO v_out;

    RETURN v_out;
END;
$$;
-- Grants on incident_print_record are unchanged by this replace (Postgres
-- keeps a function's ACL across CREATE OR REPLACE when the signature is
-- identical), but restate them anyway — cheap, and it is exactly the kind of
-- assumption this schema's own history says to re-verify rather than trust.
REVOKE ALL ON FUNCTION public.incident_print_record(bigint) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.incident_print_record(bigint) TO authenticated;

-- ============================================================
-- APPLIED AND VERIFIED IN PRODUCTION 2026-08-28
-- ============================================================
--   anon EXECUTE admin_add_incident_addendum(bigint,text)   false
--   authenticated EXECUTE (same)                             true
--   anon INSERT/SELECT on incident_report_addenda            false / false
--   authenticated INSERT on incident_report_addenda           false (write only via the RPC)
--   authenticated SELECT on incident_report_addenda            true
--
-- Functional test against a real student row, impersonating a real 'full'-role
-- admin (dinger@timothystl.org): filed a test incident, added an addendum
-- through admin_add_incident_addendum, confirmed a direct UPDATE on the
-- resulting row raised the append-only exception (23514), completed all three
-- signatures, and confirmed incident_print_record() returned the addendum
-- inside its 'addenda' array alongside the report and signatures. All test
-- rows (incident_report_addenda, incident_signatures, incident_reports)
-- deleted immediately after — the live catalog carries no trace of this test.
-- ============================================================
