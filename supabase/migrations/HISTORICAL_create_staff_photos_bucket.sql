-- Migration: create_staff_photos_bucket.sql
-- Creates the staff-photos Supabase Storage bucket used by the admin
-- Staff Directory section (Settings tab) to host lead-teacher/leadership
-- headshots shown on the public "Our Staff" section.
-- Bucket is public (anyone can view), authenticated (admin) only for writes.

-- -----------------------------------------------------------------------
-- Bucket
-- -----------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'staff-photos',
    'staff-photos',
    true,
    5242880,   -- 5 MB per file
    ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------
-- RLS policies
-- -----------------------------------------------------------------------
-- Public can view any photo in the bucket.
CREATE POLICY "Public read staff photos"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'staff-photos');

-- Only authenticated admins may upload (INSERT) photos.
CREATE POLICY "Admin insert staff photos"
    ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'staff-photos' AND auth.role() = 'authenticated');

-- Only authenticated admins may replace (UPDATE) photos.
CREATE POLICY "Admin update staff photos"
    ON storage.objects FOR UPDATE
    USING (bucket_id = 'staff-photos' AND auth.role() = 'authenticated');

-- Only authenticated admins may delete photos.
CREATE POLICY "Admin delete staff photos"
    ON storage.objects FOR DELETE
    USING (bucket_id = 'staff-photos' AND auth.role() = 'authenticated');
