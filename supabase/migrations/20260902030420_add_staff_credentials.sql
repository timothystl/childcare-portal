-- Migration: add_staff_credentials.sql
-- Staff-app Account tab, "Your details and training" — asked for directly:
-- let staff upload their own CPR/first-aid certification and (new) biannual
-- TB test records, replacing the static placeholder text that screen has
-- shipped with since the Staff tab consolidation.
--
-- Modeled on staff_injury_reports: staff have no Supabase account, so every
-- read/write goes through a PIN-gated SECURITY DEFINER RPC. One row per
-- credential EVENT (a cert renewal, a TB test), not one row per staff member
-- — "current" is read off the latest row per (staff_id, credential_type), and
-- history is kept rather than overwritten, the same reasoning fire_drills and
-- incident_reports use for their own records: a real training file is a
-- stack of dated entries, not one mutable status field.
--
-- ⚠️ A TB test result is medical information about an employee, the same
-- class of sensitivity staff_injury_reports already carries ("names an
-- employee, their body, and where they were treated"). Admin-side viewing is
-- gated to admin_role() = 'full' from the start, not is_admin() — NEW-6/SX6
-- elsewhere in this repo's history is exactly the mistake of gating a
-- sensitive table on "any admin" and fixing it later; no reason to repeat it
-- here when the lesson is already on record.

CREATE TABLE IF NOT EXISTS staff_credentials (
    id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    staff_id              uuid NOT NULL REFERENCES staff(id),
    credential_type       text NOT NULL CHECK (credential_type IN ('cpr_first_aid', 'tb_test', 'other')),
    label                 text,          -- free text for 'other', or a note (issuing org, etc.)
    completed_at          date NOT NULL, -- when the training/test happened
    expires_at            date,          -- when it's next due
    document_path         text,          -- path in the staff-credentials bucket; NULL if none attached yet
    uploaded_by_staff_id  uuid REFERENCES staff(id),
    created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS staff_credentials_staff_idx
    ON staff_credentials (staff_id, credential_type, completed_at DESC);

ALTER TABLE staff_credentials ENABLE ROW LEVEL SECURITY;

-- No anon or authenticated table grants at all — every access goes through a
-- SECURITY DEFINER RPC (staff's own PIN, or a full admin), same posture as
-- staff_injury_reports and staff_write_ups. Default privileges hand a new
-- public table ALL to anon/authenticated (the NEW-1/SX1 trap this repo has
-- hit twice already), so the revoke here is explicit rather than assumed.
REVOKE ALL ON staff_credentials FROM anon, authenticated, PUBLIC;

DROP POLICY IF EXISTS "service role only" ON staff_credentials;
CREATE POLICY "service role only" ON staff_credentials FOR ALL USING (false);

-- ── Staff: list only their OWN credentials ──────────────────────────────
-- ⚠️ No parameter widens this to another staff member's records — same rule
-- staff_my_schedule() documents for itself.
CREATE OR REPLACE FUNCTION staff_list_credentials(p_staff_id uuid, p_pin integer)
RETURNS TABLE (
    id bigint, credential_type text, label text,
    completed_at date, expires_at date, has_document boolean, created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE v_staff_id uuid;
BEGIN
    v_staff_id := staff_id_for_pin(p_staff_id, p_pin);
    IF v_staff_id IS NULL THEN RETURN; END IF;

    RETURN QUERY
    SELECT sc.id, sc.credential_type, sc.label, sc.completed_at, sc.expires_at,
           (sc.document_path IS NOT NULL) AS has_document, sc.created_at
    FROM staff_credentials sc
    WHERE sc.staff_id = v_staff_id
    ORDER BY sc.credential_type, sc.completed_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION staff_list_credentials(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_list_credentials(uuid, integer) TO anon, authenticated;

-- Submitting a credential (with or without a document) is a single edge
-- function, submit-staff-credential -- it verifies the PIN itself and, with
-- the service role, both writes the storage object (if one was sent) and
-- inserts the row, so there is one write path rather than a plain RPC here
-- duplicating half of what that function already does. (An earlier draft of
-- this migration had a separate staff_submit_credential RPC for the
-- no-document case; dropped before anything called it, in favor of the one
-- path covering both cases.)

-- ── Admin (full role only): every staff member's latest credential per
--    type, so the office can see at a glance who's current, expiring, or has
--    nothing on file. Returns document_path directly rather than a separate
--    lookup RPC -- a full admin is already cleared to see it, and the
--    storage policy below re-checks admin_role() = 'full' independently
--    before the signed URL is ever minted, so nothing here is a shortcut
--    around that check. ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_list_staff_credentials()
RETURNS TABLE (
    id bigint, staff_id uuid, staff_name text, credential_type text, label text,
    completed_at date, expires_at date, document_path text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
    -- ⚠️ admin_role() returns NULL, not a string, for any caller with no
    -- admin_roles entry at all (a parent's real Supabase Auth session, most
    -- notably). `NULL <> 'full'` is NULL, and `IF NULL THEN` does not take
    -- the branch -- unlike a WHERE/USING clause, where a NULL condition
    -- excludes the row, an IF that evaluates to NULL just falls through to
    -- whatever comes after it. Caught live before this shipped: a rolled-back
    -- probe as an email with no admin_roles entry returned this table's real
    -- rows under the un-coalesced version of this guard. COALESCE forces the
    -- non-admin case to compare against '', which is reliably not 'full'.
    IF COALESCE(admin_role(), '') <> 'full' THEN RETURN; END IF;

    RETURN QUERY
    SELECT DISTINCT ON (sc.staff_id, sc.credential_type)
        sc.id, sc.staff_id, s.name AS staff_name, sc.credential_type, sc.label,
        sc.completed_at, sc.expires_at, sc.document_path
    FROM staff_credentials sc
    JOIN staff s ON s.id = sc.staff_id
    ORDER BY sc.staff_id, sc.credential_type, sc.completed_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION admin_list_staff_credentials() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_list_staff_credentials() TO authenticated;

-- ── Storage: a private bucket for the attached scans/photos ─────────────
-- Written by the submit-staff-credential edge function using the service
-- role (staff have no Supabase session to satisfy a storage RLS policy with
-- directly) -- same shape as child-photos / upload-child-photo. Read is
-- full-admin only, same gate as the RPC above.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('staff-credentials', 'staff-credentials', false,
        8388608,  -- 8 MB -- a scanned card or a phone photo of one
        ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
    SET public = false,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Full admin read staff credentials" ON storage.objects;
CREATE POLICY "Full admin read staff credentials"
    ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'staff-credentials' AND public.admin_role() = 'full');

-- No anon policy, no write policy for authenticated at all -- the edge
-- function is the only writer, via the service role, which bypasses RLS.

-- ============================================================
-- VERIFICATION TO RUN AFTER APPLYING (as the roles themselves, rolled back)
-- ============================================================
-- 1. anon:  EXECUTE on staff_list_credentials -> true; returns no rows for a
--    wrong PIN.
-- 2. authenticated, restricted-role admin: admin_list_staff_credentials() ->
--    0 rows (admin_role() <> 'full' short-circuits before the query runs).
-- 3. authenticated, full-role admin: admin_list_staff_credentials() -> real
--    rows; SELECT on storage.objects for bucket 'staff-credentials' -> real
--    objects.
-- 4. anon: SELECT on storage.objects for bucket 'staff-credentials' -> 0 rows.
-- 5. select public from storage.buckets where id = 'staff-credentials' -> false.
