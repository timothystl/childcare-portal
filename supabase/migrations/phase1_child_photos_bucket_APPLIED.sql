-- APPLIED TO PRODUCTION 2026-08-12.
-- ============================================================
-- PHASE 1 — the child-photos bucket
-- ============================================================
-- ⚠️ PRIVATE, unlike staff-photos. That bucket is public because it holds
-- headshots the marketing site displays on purpose. This one holds photographs
-- of other people's children, and a public bucket means anyone who guesses or
-- is sent a URL can view them forever, with no consent check and no expiry.
--
-- Access is decided by the SAME rules as the child_photos table: a parent sees
-- an object only if their child is depicted AND every child in it has
-- photo_release. Putting the check here rather than in a URL-signing edge
-- function keeps one source of truth — if the table says a parent cannot see a
-- photo, the bytes are unreachable too.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('child-photos', 'child-photos', false,
        5242880,  -- 5 MB; the phone compresses well below this before upload
        ARRAY['image/jpeg', 'image/webp'])
ON CONFLICT (id) DO UPDATE
    SET public = false,               -- never let this flip to public
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Parent read own child photos" ON storage.objects;
DROP POLICY IF EXISTS "Admin all child photos"       ON storage.objects;

-- storage.objects.name is the path within the bucket, which is exactly what
-- child_photos.storage_path holds.
CREATE POLICY "Parent read own child photos"
    ON storage.objects FOR SELECT TO authenticated
    USING (
        bucket_id = 'child-photos'
        AND EXISTS (
            SELECT 1 FROM public.child_photos p
            WHERE p.storage_path = storage.objects.name
              AND public.photo_depicts_my_child(p.id)
              AND public.photo_is_releasable(p.id)
        )
    );

CREATE POLICY "Admin all child photos"
    ON storage.objects FOR ALL TO authenticated
    USING (bucket_id = 'child-photos' AND public.is_admin())
    WITH CHECK (bucket_id = 'child-photos' AND public.is_admin());

-- No anon policy at all. Staff upload through the upload-child-photo edge
-- function, which verifies the PIN and writes with the service role — the same
-- shape as every other staff write. anon must never hold storage grants on
-- photographs of children.

-- ── Retention ───────────────────────────────────────────────
-- Daily photos are ephemeral and parents are told so ON THE PAGE, next to the
-- pictures. Incident photos are NEVER swept (guidelines 3 years, statute of
-- limitations 5, major injury until the child is 23 — all longer than any cron
-- should decide).
--
-- Returns the paths it removed so the caller can delete the objects; the rows
-- go first, because an orphaned object is recoverable and an orphaned row
-- pointing at bytes that no longer exist renders as a broken photo.
CREATE OR REPLACE FUNCTION public.sweep_expired_child_photos()
RETURNS TABLE (removed_path text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    DELETE FROM child_photos
    WHERE kind = 'daily'
      AND expires_at IS NOT NULL
      AND expires_at < now()
    RETURNING storage_path;
$$;
REVOKE EXECUTE ON FUNCTION public.sweep_expired_child_photos() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.sweep_expired_child_photos() TO authenticated;

-- ============================================================
-- VERIFIED AFTER APPLYING, as the roles themselves (rolled back)
-- ============================================================
-- Four objects seeded: my child alone; my child + a released child; my child +
-- an OPTED-OUT child; another family's child only.
--   parent -> reads exactly two: solo.jpg and group-ok.jpg
--             group-optout.jpg and not-mine.jpg are unreachable
--   anon   -> 0 objects visible in the bucket
