-- ============================================================
-- PHASE 1 — a parent can read their own children
-- ============================================================
-- The Today feed needs the child switcher, and the child profile needs
-- allergies / care notes / photo_release. students is admin-scoped, so a parent
-- currently sees nothing.
--
-- ⚠️ Named TO authenticated, not TO public. `public` includes authenticated and
-- is what leaked staff wages and church payroll earlier today.

DROP POLICY IF EXISTS "parent read own children" ON public.students;
CREATE POLICY "parent read own children" ON public.students
    FOR SELECT TO authenticated
    USING (family_id IN (SELECT parent_family_ids()));

-- Photo release is parent-toggleable by design: the default is released, and
-- the director fixes the handful of exceptions. A parent flipping their OWN
-- child's consent is the intended flow.
--
-- Done as a definer RPC rather than an UPDATE policy on students, because an
-- UPDATE policy grants the whole ROW — a parent could then rewrite child_dob,
-- room_override or recurring_days, all of which drive billing and placement.
-- Postgres has no column-level RLS; a narrow function is the only way to
-- expose exactly one field.
CREATE OR REPLACE FUNCTION public.set_photo_release(p_student_id uuid, p_released boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT parent_owns_student(p_student_id) AND NOT is_admin() THEN
        RETURN false;
    END IF;
    UPDATE students SET photo_release = COALESCE(p_released, true)
    WHERE id = p_student_id;
    RETURN true;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.set_photo_release(uuid, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.set_photo_release(uuid, boolean) TO authenticated;
