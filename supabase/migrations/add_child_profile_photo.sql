-- Migration: add_child_profile_photo.sql
-- Adds a single, permanent profile picture per child, attached to their
-- record in the Families tool (admin-families.js).
--
-- ⚠️ NOT the same feature as `child_photos` (phase1_child_photos_bucket_APPLIED.sql).
-- That table/bucket is a private, consent-gated, ephemeral DAILY PHOTO FEED —
-- many timestamped photos per child, swept on a schedule, gated on
-- photo_release. This is the opposite shape: ONE photo per child, kept until
-- an admin replaces or removes it, used to recognize a child on the roster —
-- not a feed. Do not merge the two.
--
-- Modeled on child-photos, NOT staff-photos: this is a photograph of someone
-- else's minor child, so the bucket is PRIVATE like child-photos, not public
-- like staff-photos (which exists only to publish headshots on the marketing
-- site on purpose).

ALTER TABLE public.students ADD COLUMN IF NOT EXISTS profile_photo_path text;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('child-profile-photos', 'child-profile-photos', false,
        5242880,  -- 5 MB
        ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
    SET public = false,   -- never let this flip to public
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Admin all child profile photos"        ON storage.objects;
DROP POLICY IF EXISTS "Parent read own child profile photo"   ON storage.objects;

-- Admin manages every photo (upload/replace/delete) from the Families tool.
CREATE POLICY "Admin all child profile photos"
    ON storage.objects FOR ALL TO authenticated
    USING (bucket_id = 'child-profile-photos' AND public.is_admin())
    WITH CHECK (bucket_id = 'child-profile-photos' AND public.is_admin());

-- A parent may view only their own child's photo. storage.objects.name is the
-- path within the bucket, i.e. students.profile_photo_path.
CREATE POLICY "Parent read own child profile photo"
    ON storage.objects FOR SELECT TO authenticated
    USING (
        bucket_id = 'child-profile-photos'
        AND EXISTS (
            SELECT 1 FROM public.students s
            WHERE s.profile_photo_path = storage.objects.name
              AND public.parent_owns_student(s.id)
        )
    );

-- No anon policy at all, and no anon table grant on the new column beyond
-- whatever `students` already grants (SELECT was revoked from anon on this
-- table in anon_grant_sweep_2026-08-14.sql; nothing here widens that).

-- ============================================================
-- VERIFICATION TO RUN AFTER APPLYING (as the roles themselves, rolled back)
-- ============================================================
-- 1. anon:          SELECT on storage.objects where bucket_id =
--                    'child-profile-photos' -> 0 rows, no matter what exists.
-- 2. authenticated (non-admin parent session): can sign/read only the object
--    whose name equals their own child's students.profile_photo_path.
-- 3. authenticated (is_admin()): full read/write/delete on the bucket.
-- 4. has_table_privilege('anon', 'students', 'SELECT') -> false (unchanged).
