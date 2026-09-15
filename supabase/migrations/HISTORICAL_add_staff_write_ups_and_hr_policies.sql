-- ============================================================
-- Staff write-ups + HR policy document storage
-- ============================================================
-- Built for the Staff tab consolidation (design_handoff_staff, 2026-08-28),
-- which added a new "HR & Handbook" tool with three tabs: Policies,
-- Write-ups, and Staff Injury Reports (Injury Reports is the existing
-- staff_injury_reports table/RPCs, unchanged — only its section moved; see
-- the AP_TOOLS comment in admin-portal.js). This migration adds the two
-- genuinely new pieces: a write-up log, and a place to store the reference
-- policy PDFs the Policies tab lists.
--
-- Both are scoped like every other write path this app added for the
-- admin-portal role split: gated on admin_role() IN ('full', 'restricted'),
-- not is_admin() alone, because the 'staff' admin-portal role is documented
-- as Classrooms-only read access and a write-up is a real write about a
-- real employee.

-- ── Write-ups ────────────────────────────────────────────────
-- One row per write-up. Deliberately no UPDATE path for the write-up's own
-- fields (kind/note/occurred_at) once filed — same "an HR record is
-- corrected with a new dated note, never a rewrite" reasoning
-- incident_report_addenda.sql already applied to incident reports. The one
-- thing that legitimately changes after filing is whether it has been
-- acknowledged, so that alone gets its own narrow RPC rather than a general
-- UPDATE grant.
CREATE TABLE IF NOT EXISTS public.staff_write_ups (
    id             bigserial PRIMARY KEY,
    staff_id       uuid NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
    kind           text NOT NULL CHECK (btrim(kind) <> ''),
    note           text NOT NULL CHECK (btrim(note) <> ''),
    occurred_at    date NOT NULL DEFAULT CURRENT_DATE,
    issued_by_name text NOT NULL,
    status         text NOT NULL DEFAULT 'awaiting_signature'
                       CHECK (status IN ('awaiting_signature', 'signed')),
    signed_at      timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
);
-- ON DELETE RESTRICT: a write-up is a personnel record, not something that
-- should silently disappear if a staff row is ever deleted (staff are
-- deactivated, not deleted, elsewhere in this app for the same reason).

CREATE INDEX IF NOT EXISTS staff_write_ups_staff_idx
    ON public.staff_write_ups (staff_id, occurred_at DESC);

-- Acknowledgment is append-forward only: awaiting_signature -> signed, never
-- back, and never touching kind/note/occurred_at/issued_by_name. Enforced in
-- the RPC (not a trigger) because the one legitimate transition needs its
-- own timestamp write in the same statement.
CREATE OR REPLACE FUNCTION public.admin_submit_staff_write_up(
    p_staff_id    uuid,
    p_kind        text,
    p_note        text,
    p_occurred_at date DEFAULT CURRENT_DATE
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_who text; v_id bigint;
BEGIN
    IF COALESCE(admin_role(), '') NOT IN ('full', 'restricted') THEN RETURN NULL; END IF;
    IF COALESCE(btrim(p_kind), '') = '' THEN RETURN NULL; END IF;
    IF COALESCE(btrim(p_note), '') = '' THEN RETURN NULL; END IF;
    IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id) THEN RETURN NULL; END IF;

    v_who := COALESCE(auth.jwt() ->> 'email', 'Director');

    INSERT INTO staff_write_ups (staff_id, kind, note, occurred_at, issued_by_name)
    VALUES (p_staff_id, btrim(p_kind), btrim(p_note), COALESCE(p_occurred_at, CURRENT_DATE), v_who)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_submit_staff_write_up(uuid, text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_submit_staff_write_up(uuid, text, text, date) TO authenticated;

-- Marks a write-up acknowledged. There is no staff-facing e-signature flow
-- in this pass (the design handoff's own screenshots show only the admin
-- list view) — this records that the office has the staff member's
-- acknowledgment on file (in person, on paper, verbally), the same way a
-- real write-up binder would. A future pass could replace this with a
-- PIN-gated staff-side signature RPC without changing this table's shape.
CREATE OR REPLACE FUNCTION public.admin_mark_write_up_signed(p_id bigint)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
    IF COALESCE(admin_role(), '') NOT IN ('full', 'restricted') THEN RETURN false; END IF;

    UPDATE staff_write_ups
       SET status = 'signed', signed_at = now()
     WHERE id = p_id AND status = 'awaiting_signature';

    RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_mark_write_up_signed(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_mark_write_up_signed(bigint) TO authenticated;

ALTER TABLE public.staff_write_ups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_write_ups FROM anon, PUBLIC;
GRANT SELECT ON public.staff_write_ups TO authenticated;
-- Supabase's default privileges hand a new public table INSERT/UPDATE/DELETE
-- to `authenticated` — the SX1/NEW-1 dead-grant trap this schema has hit
-- twice already. Every write goes through the two definer RPCs above.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON public.staff_write_ups FROM authenticated, anon, PUBLIC;

CREATE POLICY "admin any role" ON public.staff_write_ups
    FOR SELECT TO authenticated USING (admin_role() IN ('full', 'restricted'));

-- ── HR policy document storage ──────────────────────────────
-- Private bucket, admin-only — same shape as child-documents, not
-- enrollment-forms. These are the center's own internal HR paperwork
-- (handbook, code of conduct, benefits guide), not something meant for a
-- public URL the way a parent-facing enrollment form is. "View PDF" in the
-- admin UI mints a short-lived signed URL per click rather than embedding a
-- long-lived public link.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('hr-policies', 'hr-policies', false,
        10485760,  -- 10 MB
        ARRAY['application/pdf', 'application/msword',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
ON CONFLICT (id) DO UPDATE
    SET public = false,   -- never let this flip to public
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Admin all hr policies" ON storage.objects;
CREATE POLICY "Admin all hr policies"
    ON storage.objects FOR ALL TO authenticated
    USING (bucket_id = 'hr-policies' AND public.is_admin())
    WITH CHECK (bucket_id = 'hr-policies' AND public.is_admin());

-- No anon policy, no parent policy — a non-admin session gets zero rows
-- from storage.objects for this bucket, matching child-documents exactly.

-- ============================================================
-- VERIFICATION TO RUN AFTER APPLYING (as the roles themselves, rolled back)
-- ============================================================
-- 1. anon EXECUTE admin_submit_staff_write_up(...)/admin_mark_write_up_signed(bigint) -> false.
-- 2. authenticated EXECUTE (same) -> true.
-- 3. anon INSERT/SELECT on staff_write_ups -> both false.
-- 4. authenticated INSERT on staff_write_ups -> false (write only via the RPCs).
-- 5. authenticated SELECT on staff_write_ups -> true.
-- 6. A probe with a seeded `staff`-role admin_roles entry gets NULL/false
--    from both RPCs; a probe with `restricted` succeeds on both.
-- 7. anon SELECT on storage.objects where bucket_id = 'hr-policies' -> 0 rows.
-- 8. select public from storage.buckets where id = 'hr-policies' -> false.
-- ============================================================
