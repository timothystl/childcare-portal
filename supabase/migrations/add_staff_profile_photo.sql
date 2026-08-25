-- Migration: add_staff_profile_photo.sql
-- Adds a profile picture per staff member, attached to their own record in
-- the Staff Roster (admin-staffing.js) — the same shape as
-- add_child_profile_photo.sql for students.
--
-- ⚠️ NOT the same bucket as the existing public `staff-photos`. That one
-- backs the marketing "Our Staff" directory (settings.staff_directory),
-- matched by NAME rather than staff id, and is deliberately public because
-- it publishes headshots on the website on purpose. This is a distinct,
-- private, per-row photo used internally to recognize a staff member on the
-- roster — a different bucket, a different table, a different audience.
--
-- The live `staff` table policy ("admin full only") already gates ALL
-- (including UPDATE of this new column) to admin_role() = 'full', so no
-- table-level RLS change is needed for the column itself — only the bucket.

ALTER TABLE public.staff ADD COLUMN IF NOT EXISTS profile_photo_path text;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('staff-profile-photos', 'staff-profile-photos', false,
        5242880,  -- 5 MB
        ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
    SET public = false,   -- never let this flip to public
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Admin all staff profile photos" ON storage.objects;

-- Admin-only, matching the staff table's own "admin full only" gate.
CREATE POLICY "Admin all staff profile photos"
    ON storage.objects FOR ALL TO authenticated
    USING (bucket_id = 'staff-profile-photos' AND public.admin_role() = 'full')
    WITH CHECK (bucket_id = 'staff-profile-photos' AND public.admin_role() = 'full');

-- No anon policy, no staff-self-read policy — the staff app (js/staff/*.js)
-- is PIN-based with no Supabase Auth session, so it has no auth.uid() to
-- scope a "read my own photo" policy against. Extending this to staff's own
-- devices would need a signing edge function (same shape as
-- upload-child-photo), not a storage RLS policy.

-- ============================================================
-- VERIFICATION TO RUN AFTER APPLYING (as the roles themselves, rolled back)
-- ============================================================
-- 1. anon: SELECT on storage.objects where bucket_id = 'staff-profile-photos'
--    -> 0 rows, no matter what exists.
-- 2. authenticated with admin_role() != 'full' (e.g. 'restricted'/'staff'):
--    denied on all four verbs.
-- 3. authenticated with admin_role() = 'full': full read/write/delete.
-- 4. has_table_privilege('anon', 'staff', 'SELECT') on profile_photo_path
--    specifically -> false (column grants are per-column here, not
--    table-wide — confirmed live before writing this migration).
