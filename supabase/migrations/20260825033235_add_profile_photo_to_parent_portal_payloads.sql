-- Migration: add_profile_photo_to_parent_portal_payloads.sql
-- Surfaces students.profile_photo_path (added in add_child_profile_photo.sql)
-- through the two SECURITY DEFINER functions that feed a parent's own session:
--   my_family_payload() -> calendar.html / app.js registration flow
--   my_account()        -> portal.html Account tab (js/portal/portal-account.js)
--
-- ⚠️ This is a deliberate reversal of a documented decision in
-- portal-account.js: paMonogram()'s comment says child avatars there are
-- "never a photo... so there is nothing to load and nothing to leak." That
-- comment is now stale — product wants the real photo shown to parents — and
-- the client-side change to actually render it belongs with this migration,
-- not left silently out of sync with it.
--
-- Both functions already scope every row through auth.uid() (parent_accounts
-- / my_parent_context()), so a caller cannot get anyone else's child's path
-- this way. The PATH ALONE is not a viewable image — the browser must still
-- sign it via fetchChildProfilePhotoUrls(), which goes through the existing
-- "Parent read own child profile photo" storage policy (parent_owns_student()).
-- A parent who is only authenticated (not admin) and not this child's own
-- family gets no signed URL for it, same as any other storage object here.
--
-- Bodies are otherwise byte-for-byte the live functions (confirmed via
-- pg_get_functiondef before writing this), with one field added to each.

CREATE OR REPLACE FUNCTION public.my_family_payload()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_family_id uuid;
    v_slot      int;
    v_family    families%ROWTYPE;
    v_students  jsonb;
BEGIN
    SELECT pa.family_id, pa.parent_slot
      INTO v_family_id, v_slot
      FROM parent_accounts pa
     WHERE pa.user_id = auth.uid();

    IF v_family_id IS NULL THEN
        RETURN 'null'::jsonb;
    END IF;

    SELECT * INTO v_family FROM families WHERE id = v_family_id;
    IF NOT FOUND THEN
        RETURN 'null'::jsonb;
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id',             s.id,
        'child_name',     s.child_name,
        'child_dob',      s.child_dob,
        'room_override',  s.room_override,
        'discount_type',  s.discount_type,
        'discount_value', s.discount_value,
        'discount_note',  s.discount_note,
        'recurring_days', s.recurring_days,
        'profile_photo_path', s.profile_photo_path
    )), '[]'::jsonb)
    INTO v_students
    FROM students s
    WHERE s.family_id = v_family_id;

    RETURN jsonb_build_object(
        'family', jsonb_build_object(
            'id',                  v_family.id,
            'parent_name',         v_family.parent_name,
            'parent_email',        v_family.parent_email,
            'parent_phone',        v_family.parent_phone,
            'parent2_name',        v_family.parent2_name,
            'parent2_email',       v_family.parent2_email,
            'parent2_phone',       v_family.parent2_phone,
            'registration_locked', v_family.registration_locked,
            'login_locked',        v_family.login_locked,
            'students',            v_students
        ),
        'isParent2', (v_slot = 2)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.my_account()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
declare v_fam uuid; v_slot int; v_out jsonb;
begin
    select (my_parent_context()->>'family_id')::uuid,
           coalesce((my_parent_context()->>'parent_slot')::int, 1)
      into v_fam, v_slot;
    if v_fam is null then return 'null'::jsonb; end if;

    select jsonb_build_object(
        'family_id', f.id,
        'my_slot',   v_slot,
        'prefs',     f.notification_prefs,
        'parents', jsonb_build_array(
            jsonb_build_object('slot', 1, 'name', f.parent_name,
                               'email', f.parent_email, 'phone', f.parent_phone,
                               'has_pin', coalesce(f.has_pin, false)),
            jsonb_build_object('slot', 2, 'name', f.parent2_name,
                               'email', f.parent2_email, 'phone', f.parent2_phone,
                               'has_pin', coalesce(f.has_parent2_pin, false))
        ),
        'children', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', s.id, 'child_name', s.child_name, 'child_dob', s.child_dob,
                       'room_override', s.room_override, 'allergies', s.allergies,
                       'care_notes', s.care_notes, 'photo_release', s.photo_release,
                       'allergies_reviewed_at', s.allergies_reviewed_at,
                       'allergies_source', s.allergies_source,
                       'profile_photo_path', s.profile_photo_path)
                       order by s.child_name)
            from students s where s.family_id = f.id), '[]'::jsonb),
        'pickup', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', p.id, 'name', p.name,
                       'relationship', p.relationship, 'note', p.note)
                       order by p.name)
            from pickup_contacts p where p.family_id = f.id), '[]'::jsonb)
    ) into v_out
    from families f where f.id = v_fam;

    return coalesce(v_out, 'null'::jsonb);
end;
$$;

-- CREATE OR REPLACE preserves existing grants when the signature is
-- unchanged, but restate them explicitly anyway — this is the exact trap
-- documented elsewhere in this repo (a bare GRANT can leave an inherited
-- PUBLIC grant standing, R26/R27/FS5).
REVOKE ALL ON FUNCTION public.my_family_payload() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_account()         FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_family_payload() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_account()         TO authenticated;

-- ============================================================
-- VERIFICATION TO RUN AFTER APPLYING
-- ============================================================
-- has_function_privilege('anon', 'public.my_family_payload()', 'EXECUTE') -> false
-- has_function_privilege('anon', 'public.my_account()', 'EXECUTE')        -> false
-- A parent session's my_account()/my_family_payload() includes
-- profile_photo_path per child; an admin session (no parent_accounts row)
-- still returns 'null'::jsonb, unchanged.
