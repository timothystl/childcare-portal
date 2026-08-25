-- Migration: parent_edit_child_profile_photo.sql
-- Lets a parent upload/replace/remove their OWN child's profile picture from
-- the portal Account tab, not just view it (add_child_profile_photo.sql was
-- admin-only; add_profile_photo_to_parent_portal_payloads.sql only surfaced
-- the existing photo for reading).
--
-- Two parts, because uploading is a chicken-and-egg problem: the storage
-- write has to be authorized BEFORE students.profile_photo_path points at
-- it, so it can't reuse the existing "Parent read own child profile photo"
-- policy (which matches against the row that already exists).
--
-- 1. A folder-per-child storage convention. A parent may write/read/delete
--    only objects under "<student_id>/...", and only for a student they
--    actually own (parent_owns_student()). The student id in the path is
--    just a routing key, not the authorization itself — owning a *different*
--    child's id would still fail parent_owns_student() for this parent.
--
--    The uuid parse is guarded by a regex first: casting a non-UUID prefix
--    straight to ::uuid would raise an error for every OTHER object in the
--    bucket (including admin's differently-named ones) rather than just
--    evaluating to false, which would make the policy fail closed for
--    reasons that have nothing to do with authorization.
--
-- 2. set_child_profile_photo(student_id, path): the only way to point
--    students.profile_photo_path at something, for parents — the table
--    itself has no parent-facing UPDATE policy (only "admin any role"), so
--    this mirrors set_photo_release()'s existing shape exactly. Re-checks
--    that a non-null path actually lives in that child's own folder, so a
--    parent cannot use this RPC to point their child's record at an object
--    that belongs to someone else (the storage policy stops the write, but
--    this is the belt to that braces on the DB side).
--
-- Existing admin-uploaded photos (flat filenames, no folder) are untouched:
-- admins keep writing students.profile_photo_path directly (admin_role() ALL
-- policy) and the existing "Parent read own child profile photo" SELECT
-- policy still matches by the current DB value regardless of naming
-- convention, so a parent can always see whatever photo is currently set.

DROP POLICY IF EXISTS "Parent manage own child profile photo folder" ON storage.objects;

CREATE POLICY "Parent manage own child profile photo folder"
    ON storage.objects FOR ALL TO authenticated
    USING (
        bucket_id = 'child-profile-photos'
        AND storage.objects.name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/'
        AND public.parent_owns_student(split_part(storage.objects.name, '/', 1)::uuid)
    )
    WITH CHECK (
        bucket_id = 'child-profile-photos'
        AND storage.objects.name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/'
        AND public.parent_owns_student(split_part(storage.objects.name, '/', 1)::uuid)
    );

CREATE OR REPLACE FUNCTION public.set_child_profile_photo(p_student_id uuid, p_path text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    IF NOT parent_owns_student(p_student_id) AND NOT is_admin() THEN
        RETURN false;
    END IF;
    -- Defense in depth: the storage policy already restricts a parent's
    -- writes to their own child's folder, but re-check here too, so this
    -- RPC alone is never sufficient to point a child's record at an object
    -- that folder convention wouldn't have allowed.
    IF p_path IS NOT NULL AND split_part(p_path, '/', 1) <> p_student_id::text THEN
        RETURN false;
    END IF;
    UPDATE students SET profile_photo_path = p_path WHERE id = p_student_id;
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.set_child_profile_photo(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_child_profile_photo(uuid, text) TO authenticated;

-- ============================================================
-- VERIFICATION TO RUN AFTER APPLYING (as the roles themselves, rolled back)
-- ============================================================
-- 1. anon: has_function_privilege('anon','set_child_profile_photo(uuid,text)','EXECUTE') -> false
-- 2. A parent session can INSERT an object at '<their-own-child-id>/x.jpg'
--    and cannot INSERT at '<someone-else's-child-id>/x.jpg' or at a
--    non-UUID-prefixed path.
-- 3. set_child_profile_photo() as that parent: succeeds for their own child
--    with a path in that child's folder; returns false for another
--    family's child, and false if the path's folder doesn't match
--    p_student_id.
-- 4. An admin session unaffected: still writes students.profile_photo_path
--    directly via the existing admin_role() policy, any filename.
