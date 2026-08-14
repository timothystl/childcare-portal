-- ============================================================
-- Let a portal session read its own family, so calendar.html
-- stops asking for the email and PIN a second time
-- ============================================================
-- A parent signs in at /portal and gets a real Supabase session. They tap
-- "Register for additional days", land on calendar.html, and are asked for
-- their email and PIN again — because that page's only way in is
-- family-lookup, which takes a PIN and returns a data payload.
--
-- Everything calendar.html needs is already derivable from the session:
-- parent_accounts maps the JWT to a family_id, and parent_family_ids() is the
-- same lookup every parent RLS policy uses. These two functions expose exactly
-- what the PIN path already returns, keyed on the token instead of a PIN.
--
--   family_login(email, pin).family -> my_family_payload()
--   family_registrations(email, pin) -> my_family_registrations()
--
-- The payloads are byte-for-byte the same shape as the PIN versions, because
-- app.js has one selectFamily() and one loadSiblingBookedDays() and both paths
-- feed them. A different shape here would mean a second set of call sites
-- drifting away from the first.
--
-- ⚠️ No PIN is checked here and none should be added. The session IS the
-- credential — it was issued by parent-session only after family_login
-- verified the PIN with bcrypt, under the lockout counter. Re-checking a PIN
-- would mean the browser had to hold one, which is the whole thing being
-- removed.
--
-- SECURITY. Both are SECURITY DEFINER with search_path pinned, and both scope
-- every row through parent_family_ids() off auth.uid() — a caller cannot name
-- the family they want, the token decides. EXECUTE is granted to
-- `authenticated` only, and revoked from PUBLIC and anon explicitly: a bare
-- GRANT leaves the inherited `=X/postgres` PUBLIC grant in place, which is the
-- trap R26/R27 and FS5 Phase 1 all hit.
--
-- An admin is also `authenticated`, but has no parent_accounts row, so
-- parent_family_ids() returns nothing and both functions return empty. There is
-- no path here to another family's data.
-- ============================================================

-- ── The family a session belongs to ─────────────────────────────────────────
-- Mirrors the 'family' object built by family_login, plus isParent2, which
-- comes from parent_accounts.parent_slot rather than from matching an address.
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
        'recurring_days', s.recurring_days
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

-- ── That family's registrations ─────────────────────────────────────────────
-- The body is family_registrations' body with verify_family_pin(email, pin)
-- replaced by the session lookup. registrations has no family_id column, so
-- the join is on parent_email against both of the family's addresses —
-- the same condition family_registrations uses, kept identical deliberately.
CREATE OR REPLACE FUNCTION public.my_family_registrations()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
    v_family_id uuid;
    v_out       jsonb;
BEGIN
    SELECT pa.family_id INTO v_family_id
      FROM parent_accounts pa
     WHERE pa.user_id = auth.uid();

    IF v_family_id IS NULL THEN
        RETURN '[]'::jsonb;
    END IF;

    SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb) INTO v_out
    FROM (
        SELECT jsonb_build_object(
            'id', r.id, 'created_at', r.created_at, 'status', r.status,
            'parent_name', r.parent_name, 'parent_email', r.parent_email,
            'parent_phone', r.parent_phone, 'child_name', r.child_name,
            'room_id', r.room_id, 'month_key', r.month_key,
            'registration_dates', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'care_date', d.care_date, 'waitlisted', d.waitlisted,
                    'day_type', d.day_type, 'room_id', d.room_id,
                    'change_fee', d.change_fee) ORDER BY d.care_date)
                FROM registration_dates d WHERE d.registration_id = r.id), '[]'::jsonb)
        ) AS x
        FROM registrations r, families f
        WHERE f.id = v_family_id
          AND (lower(r.parent_email) = lower(f.parent_email)
            OR (COALESCE(f.parent2_email,'') <> '' AND lower(r.parent_email) = lower(f.parent2_email)))
    ) s;

    RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.my_family_payload()       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_family_registrations()  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_family_payload()      TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_family_registrations() TO authenticated;
