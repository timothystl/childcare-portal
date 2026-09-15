-- Migration: create_enrollment_forms_bucket.sql
-- Creates the enrollment-forms Supabase Storage bucket for hosting
-- downloadable enrollment PDFs/docs on the public /enroll page.
-- Bucket is public (anyone can read), authenticated (admin) only for writes.

-- -----------------------------------------------------------------------
-- Bucket
-- -----------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'enrollment-forms',
    'enrollment-forms',
    true,
    10485760,   -- 10 MB per file
    ARRAY[
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]
)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------
-- RLS policies
-- -----------------------------------------------------------------------
-- Public can download (SELECT) any file in the bucket.
CREATE POLICY "Public read enrollment forms"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'enrollment-forms');

-- Only authenticated admins may upload (INSERT) files.
CREATE POLICY "Admin insert enrollment forms"
    ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'enrollment-forms' AND auth.role() = 'authenticated');

-- Only authenticated admins may delete files.
CREATE POLICY "Admin delete enrollment forms"
    ON storage.objects FOR DELETE
    USING (bucket_id = 'enrollment-forms' AND auth.role() = 'authenticated');
