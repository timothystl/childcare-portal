-- Migration: add_child_documents_bucket.sql
-- Adds per-child document storage (immunization records, signed forms, etc.)
-- to the redesigned Family Directory modal (design handoff:
-- design_handoff_classroom_tab_full, "Documents" per child).
--
-- ⚠️ NOT the same feature as child-profile-photos or the child_photos daily
-- feed. This is arbitrary office paperwork, not a photograph — multiple files
-- per child, admin-managed, no parent access. There is no metadata table:
-- listing/removing works directly off storage.objects, one folder per child
-- (named by students.id), the same "scope by folder" convention
-- add_child_profile_photo.sql's parent-facing path already uses. A folder
-- per child means listing a child's documents is `storage.list(studentId)` —
-- no join table to keep in sync, and no orphan-row risk if a file is removed
-- straight from the dashboard.
--
-- Admin-only, on purpose: unlike the photo bucket, nothing here grants a
-- parent read policy. These are the director's own paperwork records, not
-- something the redesign asked to publish into the parent app, and adding
-- that later is a strictly additive policy change if it's ever wanted.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('child-documents', 'child-documents', false,
        10485760,  -- 10 MB — scanned multi-page PDFs run larger than a photo
        ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
    SET public = false,   -- never let this flip to public
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Admin all child documents" ON storage.objects;

CREATE POLICY "Admin all child documents"
    ON storage.objects FOR ALL TO authenticated
    USING (bucket_id = 'child-documents' AND public.is_admin())
    WITH CHECK (bucket_id = 'child-documents' AND public.is_admin());

-- No anon policy, no parent policy. A non-admin authenticated session (a
-- parent) gets zero rows from storage.objects for this bucket.

-- ============================================================
-- VERIFICATION TO RUN AFTER APPLYING (as the roles themselves, rolled back)
-- ============================================================
-- 1. anon:                       SELECT on storage.objects where bucket_id =
--                                 'child-documents' -> 0 rows.
-- 2. authenticated, non-admin:   SELECT on storage.objects where bucket_id =
--                                 'child-documents' -> 0 rows (no parent policy exists).
-- 3. authenticated, is_admin():  full read/write/delete on the bucket.
-- 4. select public from storage.buckets where id = 'child-documents' -> false.
