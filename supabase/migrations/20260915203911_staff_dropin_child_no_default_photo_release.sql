-- A new student created from a name typed at the door has given no photo
-- consent, but photo_release defaults to true on the students table. The
-- sibling door-kiosk RPC (record_door_checkin, before/after care —
-- 20260915171936_record_door_checkin_fix_staff_pin_signature.sql) already
-- caught this: "photo_release DEFAULTS TO TRUE, a consent nobody gave when a
-- name is typed at a door. Set false and let the office ask." The same fact
-- applies to a walk-in checked into a room by staff_add_dropin_child — a
-- parent handing over a name at the door has not filled out the real
-- enrollment paperwork, so this must not default to releasing the photo.
--
-- No other change from the version applied as 20260915203139.
CREATE OR REPLACE FUNCTION public.staff_add_dropin_child(
    p_staff_id uuid, p_pin integer, p_room_id text, p_care_date date DEFAULT NULL,
    p_day_type text DEFAULT 'full', p_apply_dropin_fee boolean DEFAULT true,
    p_existing_student_id uuid DEFAULT NULL,
    p_child_name text DEFAULT NULL, p_child_age integer DEFAULT NULL,
    p_child_dob date DEFAULT NULL, p_parent_name text DEFAULT NULL,
    p_parent_email text DEFAULT NULL, p_parent_phone text DEFAULT NULL
) RETURNS TABLE (student_id uuid, child_name text, allergies jsonb,
                  care_notes text, photo_release boolean,
                  allergies_reviewed boolean, attendance_status text,
                  drop_in boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $f$
DECLARE
    v_staff_id uuid; v_date date; v_fee numeric; v_month text;
    v_student uuid; v_family uuid; v_child_name text;
    v_parent_name text; v_parent_email text; v_parent_phone text;
    v_reg_id bigint;
BEGIN
    v_staff_id := staff_id_for_pin(p_staff_id, p_pin);
    IF v_staff_id IS NULL THEN RETURN; END IF;

    IF p_room_id IS NULL OR trim(p_room_id) = '' THEN RETURN; END IF;
    IF p_day_type NOT IN ('full','half') THEN p_day_type := 'full'; END IF;
    v_date := COALESCE(p_care_date, (now() AT TIME ZONE 'America/Chicago')::date);
    v_fee  := CASE WHEN p_apply_dropin_fee THEN 5 ELSE 0 END;

    IF p_existing_student_id IS NOT NULL THEN
        SELECT st.id, st.family_id, st.child_name
          INTO v_student, v_family, v_child_name
          FROM students st WHERE st.id = p_existing_student_id;
        IF v_student IS NULL OR v_family IS NULL THEN RETURN; END IF;

        SELECT f.parent_name, f.parent_email, f.parent_phone
          INTO v_parent_name, v_parent_email, v_parent_phone
          FROM families f WHERE f.id = v_family;
        v_parent_email := lower(trim(COALESCE(v_parent_email, '')));
        IF v_parent_email = '' THEN RETURN; END IF;
    ELSE
        v_child_name   := NULLIF(trim(COALESCE(p_child_name, '')), '');
        v_parent_name  := NULLIF(trim(COALESCE(p_parent_name, '')), '');
        v_parent_email := lower(NULLIF(trim(COALESCE(p_parent_email, '')), ''));
        v_parent_phone := NULLIF(trim(COALESCE(p_parent_phone, '')), '');
        IF v_child_name IS NULL OR v_parent_name IS NULL OR v_parent_email IS NULL THEN
            RETURN;
        END IF;

        SELECT f.id INTO v_family FROM families f
         WHERE lower(trim(f.parent_email)) = v_parent_email
            OR lower(trim(COALESCE(f.parent2_email, ''))) = v_parent_email
         LIMIT 1;

        IF v_family IS NULL THEN
            INSERT INTO families (parent_name, parent_email, parent_phone)
            VALUES (v_parent_name, v_parent_email, COALESCE(v_parent_phone, ''))
            RETURNING id INTO v_family;
        END IF;

        -- ⚠️ photo_release defaults to true on this table. A name typed at
        -- the door carries no photo consent, so this must be explicit.
        INSERT INTO students (family_id, child_name, child_dob, photo_release)
        VALUES (v_family, v_child_name, p_child_dob, false)
        RETURNING id INTO v_student;
    END IF;

    v_month := to_char(v_date, 'YYYY-MM');

    SELECT r.id INTO v_reg_id
      FROM registrations r
     WHERE r.status = 'confirmed'
       AND r.month_key = v_month
       AND lower(trim(r.parent_email)) = v_parent_email
       AND lower(trim(r.child_name)) = lower(v_child_name)
     ORDER BY r.created_at DESC
     LIMIT 1;

    IF v_reg_id IS NULL THEN
        -- A brand-new registration needs an age the client must supply — the
        -- same requirement the public registration form makes of a parent.
        IF p_child_age IS NULL THEN RETURN; END IF;

        INSERT INTO registrations (
            parent_name, parent_email, parent_phone, child_name, child_age,
            child_dob, room_id, status, submitted_by, month_key
        ) VALUES (
            v_parent_name, v_parent_email, COALESCE(v_parent_phone, ''),
            v_child_name, p_child_age, p_child_dob, p_room_id,
            'confirmed', 'staff', v_month
        ) RETURNING id INTO v_reg_id;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM registration_dates
         WHERE registration_id = v_reg_id AND care_date = v_date
           AND room_id = p_room_id AND waitlisted IS NOT TRUE
    ) THEN
        INSERT INTO registration_dates (
            registration_id, room_id, care_date, waitlisted, day_type,
            change_fee, is_dropin
        ) VALUES (
            v_reg_id, p_room_id, v_date, false, p_day_type, v_fee, true
        );
    END IF;

    -- Same check-in every other roster tap uses — child_day_events row,
    -- attendance_records upsert, all through the one function that owns
    -- that logic.
    PERFORM public.log_child_event(p_staff_id, p_pin, v_student, 'check_in',
                                    '{}'::jsonb, NULL, v_date);

    -- Fold the new day into the family's CURRENT invoice now. This writes a
    -- draft invoice, not a charge — Stax charging stays invoice-only
    -- (create-stax-charge requires status IN ('sent','partial')), so the
    -- card is billed on the normal cycle, same as admin's Add-Day flow.
    PERFORM public._reconcile_billing_invoice_internal(v_family, v_month::char(7));

    RETURN QUERY
    SELECT st.id, st.child_name, st.allergies, st.care_notes, st.photo_release,
           (st.allergies_reviewed_at IS NOT NULL), 'present'::text, true
      FROM students st WHERE st.id = v_student;
END;
$f$;
REVOKE EXECUTE ON FUNCTION public.staff_add_dropin_child(
    uuid, integer, text, date, text, boolean, uuid, text, integer, date, text, text, text
) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.staff_add_dropin_child(
    uuid, integer, text, date, text, boolean, uuid, text, integer, date, text, text, text
) TO anon, authenticated;
