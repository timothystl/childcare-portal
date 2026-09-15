-- Staff dedicated check-in/out feed + walk-in (drop-in) children.
--
-- The Room roster (list_room_children / log_child_event) already IS the
-- staff check-in feed — this does not replace it, it finishes it:
--   1. A child who walks in without a booking has never had a way onto that
--      roster. staff_add_dropin_child() creates the missing registration
--      (and, if nobody has ever heard of this child, the family/student
--      record too), marks the child present through the same log_child_event
--      path every other check-in uses, and folds the charge into the
--      family's CURRENT invoice immediately via
--      _reconcile_billing_invoice_internal — the same "recompute now, charge
--      on the normal cycle" behavior the admin "+ Add Child to This Day"
--      button already uses. There is no ad-hoc/instant card charge here;
--      Stax charging stays invoice-only (create-stax-charge), unchanged.
--   2. list_room_children gets the `drop_in` marker staff-room-head.js has
--      been waiting for since it shipped (see its header comment) — no
--      client change needed for the ratio bar's "Extra today" band to light
--      up on its own.
--
-- ⚠️ TYPE TRAP: students.id/families.id/staff.id are uuid; registrations.id
-- and registration_dates.id are bigint. Never coerce with Number()/parseInt().
--
-- ACCESS MODEL: same as the rest of Phase 1 — staff have no Supabase
-- account, so every write is a PIN-gated SECURITY DEFINER RPC
-- (staff_id_for_pin(p_staff_id, p_pin), matching the live signature these
-- RPCs already use — NOT the p_pin-only shape in the historical migration
-- file, which was superseded by 20260812213650_staff_signin_name_then_pin.sql
-- and no longer matches production). anon gets no table grant.

ALTER TABLE public.registration_dates
    ADD COLUMN IF NOT EXISTS is_dropin boolean NOT NULL DEFAULT false;

-- ── list_room_children — add the drop_in marker ────────────────────────
-- CREATE OR REPLACE cannot add an output column to an existing table
-- function; drop first.
DROP FUNCTION IF EXISTS public.list_room_children(uuid, integer, text, date);

CREATE FUNCTION public.list_room_children(
    p_staff_id uuid, p_pin integer, p_room_id text, p_care_date date DEFAULT NULL
) RETURNS TABLE (student_id uuid, child_name text, allergies jsonb,
                  care_notes text, photo_release boolean, checked_in boolean,
                  allergies_reviewed boolean, attendance_status text,
                  drop_in boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
DECLARE v_staff_id uuid; v_date date;
BEGIN
    v_staff_id := staff_id_for_pin(p_staff_id, p_pin);
    IF v_staff_id IS NULL THEN RETURN; END IF;
    v_date := COALESCE(p_care_date, (now() AT TIME ZONE 'America/Chicago')::date);

    RETURN QUERY
    WITH last_ev AS (
        SELECT DISTINCT ON (e.student_id) e.student_id, e.event_type
        FROM child_day_events e
        WHERE e.care_date = v_date AND e.event_type IN ('check_in','check_out')
        ORDER BY e.student_id, e.occurred_at DESC, e.id DESC
    )
    SELECT DISTINCT ON (st.id)
        st.id, st.child_name, st.allergies, st.care_notes, st.photo_release,
        EXISTS (SELECT 1 FROM child_day_events e2
                WHERE e2.student_id = st.id AND e2.care_date = v_date
                  AND e2.event_type = 'check_in') AS checked_in,
        (st.allergies_reviewed_at IS NOT NULL) AS allergies_reviewed,
        CASE
            WHEN le.event_type = 'check_in'  THEN 'present'
            WHEN le.event_type = 'check_out' THEN 'left'
            ELSE 'not_arrived'
        END AS attendance_status,
        COALESCE(rd.is_dropin, false) AS drop_in
    FROM registrations r
    JOIN registration_dates rd ON rd.registration_id = r.id
    JOIN students st ON lower(st.child_name) = lower(r.child_name)
    LEFT JOIN last_ev le ON le.student_id = st.id
    WHERE rd.care_date = v_date AND rd.waitlisted IS NOT TRUE AND r.room_id = p_room_id
    ORDER BY st.id, st.child_name;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.list_room_children(uuid, integer, text, date) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.list_room_children(uuid, integer, text, date) TO anon, authenticated;

-- ── staff_search_children — find a known child not on today's roster ──
-- Minimal-disclosure by design: a staff PIN can now look up any child by
-- name (not just today's room), which is broader than list_room_children's
-- reach. In exchange it returns nothing but a name and the parent's name —
-- no email, phone, allergy, or family id. Contact details never leave the
-- server; staff_add_dropin_child() resolves them internally from the id the
-- staff member picks.
CREATE OR REPLACE FUNCTION public.staff_search_children(
    p_staff_id uuid, p_pin integer, p_query text
) RETURNS TABLE (student_id uuid, child_name text, parent_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
DECLARE v_staff_id uuid; v_q text;
BEGIN
    v_staff_id := staff_id_for_pin(p_staff_id, p_pin);
    IF v_staff_id IS NULL THEN RETURN; END IF;

    v_q := trim(COALESCE(p_query, ''));
    IF length(v_q) < 2 THEN RETURN; END IF;

    RETURN QUERY
    SELECT st.id, st.child_name, f.parent_name
    FROM students st
    JOIN families f ON f.id = st.family_id
    WHERE st.child_name ILIKE '%' || v_q || '%'
    ORDER BY (lower(st.child_name) LIKE lower(v_q) || '%') DESC, st.child_name
    LIMIT 8;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.staff_search_children(uuid, integer, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.staff_search_children(uuid, integer, text) TO anon, authenticated;

-- ── staff_add_dropin_child — walk-in check-in + immediate bill ─────────
-- Two shapes, chosen by whether p_existing_student_id is given:
--   * a known child (sibling, past enrollee) just not scheduled today —
--     reuses their students/families row;
--   * nobody has a record at all — creates a minimal families + students
--     row from what the parent tells staff at the door.
-- Either way: find-or-create this month's registration, add today as a
-- drop-in day (skipped if already present, so a double-tap can't double the
-- fee), mark the child present through log_child_event (same table, same
-- rules every other check-in follows), then fold the day into the family's
-- current invoice immediately — draft, not sent; the card is charged on the
-- normal billing cycle, same as "+ Add Child to This Day" in admin.
--
-- The drop-in fee is a server-side constant, not a client-supplied amount —
-- the browser chooses only whether to apply it, matching the $5 admin
-- change fee this mirrors (HISTORICAL_add_change_fee.sql).
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
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
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
        IF v_parent_email = '' THEN RETURN; END IF;   -- nothing to bill against
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

        INSERT INTO students (family_id, child_name, child_dob)
        VALUES (v_family, v_child_name, p_child_dob)
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
$$;
REVOKE EXECUTE ON FUNCTION public.staff_add_dropin_child(
    uuid, integer, text, date, text, boolean, uuid, text, integer, date, text, text, text
) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.staff_add_dropin_child(
    uuid, integer, text, date, text, boolean, uuid, text, integer, date, text, text, text
) TO anon, authenticated;

-- ============================================================
-- VERIFIED AFTER APPLYING, as anon (all rolled back)
-- ============================================================
-- bad PIN on either RPC -> empty set, no rows written
-- staff_search_children: query < 2 chars -> empty; real query -> id/name/parent_name only
-- staff_add_dropin_child, known child not on today's roster:
--   -> registration_dates row created with is_dropin=true, change_fee=5
--   -> child_day_events check_in + attendance_records 'present' written
--   -> billing_invoices draft recomputed to include the new day
--   -> list_room_children for that room/date now returns drop_in=true for the child
-- staff_add_dropin_child, brand-new child, no child_age -> empty set, nothing written
-- staff_add_dropin_child, brand-new child with age -> families + students +
--   registrations rows created, then same as above; a second call same day
--   does not duplicate the registration_dates row or the $5 fee
