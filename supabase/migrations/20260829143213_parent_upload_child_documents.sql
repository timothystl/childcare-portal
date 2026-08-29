-- Migration: parent_upload_child_documents.sql
-- Lets a parent hand in a document (immunization record, doctor's note) for
-- their OWN child from the portal Documents card, instead of only being told
-- to message the office. add_child_documents_bucket.sql was deliberately
-- admin-only ("office paperwork... nothing here grants a parent read
-- policy") — this adds a narrow write path on top of that, not a reversal
-- of it.
--
-- ⚠️ Write-only, on purpose — no parent SELECT/UPDATE/DELETE policy.
-- The existing bucket has no folder/file distinction between an
-- office-authored document and anything else that might already sit in a
-- child's folder; granting a parent SELECT on the whole folder would
-- retroactively expose files that were written under the explicit
-- assumption no parent could ever see them. A parent "hands in" a document
-- the same way they would hand over a paper copy at the counter — they
-- cannot browse the folder afterward, matching the immunization card's own
-- existing copy ("Message the office ... to hand one in"). This is
-- additive and narrower than a full read/write policy, so widening it
-- later (e.g. letting a parent see what they themselves uploaded) is a
-- separate, deliberate change, not a bug fix.
--
-- Same folder-per-child / ownership-by-path convention as
-- parent_edit_child_profile_photo.sql: a parent may INSERT only under
-- "<student_id>/...", and only for a student they actually own
-- (parent_owns_student()). The regex guard runs first so a non-UUID-prefixed
-- object (any of the admin's own filenames elsewhere in the bucket) never
-- reaches the ::uuid cast, which would otherwise raise for every row instead
-- of just evaluating to false.
--
-- Filename convention: uploadChildDocumentAsParent() (js/supabase.js) writes
-- "<student_id>/<timestamp>-parent-<original name>.<ext>" — the existing
-- admin-side display logic (listChildDocuments()) already strips a leading
-- "<digits>-" when showing a document's name, so a parent-submitted file is
-- the only kind whose displayed name still starts with "parent-", which is
-- what the admin Family Directory documents list now badges on. No new
-- metadata table, matching the bucket's own "no metadata table" design.

DROP POLICY IF EXISTS "Parent upload own child documents" ON storage.objects;

CREATE POLICY "Parent upload own child documents"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'child-documents'
        AND storage.objects.name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/'
        AND public.parent_owns_student(split_part(storage.objects.name, '/', 1)::uuid)
    );

-- No parent SELECT/UPDATE/DELETE policy — see the write-only note above.
-- The existing "Admin all child documents" policy (add_child_documents_bucket.sql)
-- is untouched: admins still have full read/write/delete on every file,
-- office-authored or parent-submitted alike.

-- ============================================================
-- VERIFICATION TO RUN AFTER APPLYING (as the roles themselves, rolled back)
-- ============================================================
-- 1. anon:                     INSERT on storage.objects for this bucket -> denied (no anon policy).
-- 2. A parent session can INSERT an object at '<their-own-child-id>/x.pdf'
--    and cannot INSERT at '<someone-else's-child-id>/x.pdf' or at a
--    non-UUID-prefixed path.
-- 3. That same parent session: SELECT on storage.objects for this bucket
--    still returns 0 rows — the write-only design is real, not aspirational.
-- 4. authenticated, is_admin(): unaffected — still full read/write/delete,
--    including on files a parent has just uploaded.
