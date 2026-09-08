-- myMDO authorization boundary hotfix
-- Production-safe intent: full administrators retain full access; restricted
-- administrators retain operational access; classroom staff are read-only on
-- the minimum roster tables; parent sessions retain only ownership-scoped access.

BEGIN;

-- `staff` is a classroom role, not an administrator role. Existing policies
-- and privileged functions that call is_admin() now admit only full/restricted.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(public.admin_role(), '') IN ('full', 'restricted');
$function$;

REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;

-- Settings contains the role map and financial/HR configuration. Lower tiers
-- receive only the exact operational rows needed by their intended UI.
DROP POLICY IF EXISTS "admin any role" ON public.settings;
DROP POLICY IF EXISTS "admin full settings write" ON public.settings;
DROP POLICY IF EXISTS "restricted settings read" ON public.settings;
DROP POLICY IF EXISTS "restricted settings update" ON public.settings;
DROP POLICY IF EXISTS "classroom staff settings read" ON public.settings;

CREATE POLICY "admin full settings write"
ON public.settings FOR ALL TO authenticated
USING (public.admin_role() = 'full')
WITH CHECK (public.admin_role() = 'full');

CREATE POLICY "restricted settings read"
ON public.settings FOR SELECT TO authenticated
USING (
  public.admin_role() = 'restricted'
  AND key IN (
    'enrollment_at_capacity', 'geofence', 'hide_summer_camp', 'new_family_fee',
    'offer_links', 'reg_window_override', 'registration_fee',
    'registration_fee_renewal_date', 'room_capacity', 'room_rates',
    'staff_availability', 'staff_directory', 'staff_ratios',
    'supply_fee_family_max', 'waitlist_notify'
  )
);

CREATE POLICY "restricted settings update"
ON public.settings FOR UPDATE TO authenticated
USING (
  public.admin_role() = 'restricted'
  AND key IN ('reg_window_override', 'staff_availability', 'waitlist_notify')
)
WITH CHECK (
  public.admin_role() = 'restricted'
  AND key IN ('reg_window_override', 'staff_availability', 'waitlist_notify')
);

CREATE POLICY "classroom staff settings read"
ON public.settings FOR SELECT TO authenticated
USING (
  public.admin_role() = 'staff'
  AND key IN ('room_capacity', 'staff_directory', 'staff_ratios')
);

-- The classroom-staff admin tier is genuinely read-only and limited to the
-- records used to render a classroom roster/attendance view.
DROP POLICY IF EXISTS "classroom staff read only" ON public.families;
DROP POLICY IF EXISTS "classroom staff read only" ON public.students;
DROP POLICY IF EXISTS "classroom staff read only" ON public.registrations;
DROP POLICY IF EXISTS "classroom staff read only" ON public.registration_dates;
DROP POLICY IF EXISTS "classroom staff read only" ON public.attendance_records;
DROP POLICY IF EXISTS "classroom staff read only" ON public.closures;

CREATE POLICY "classroom staff read only" ON public.families
FOR SELECT TO authenticated USING (public.admin_role() = 'staff');
CREATE POLICY "classroom staff read only" ON public.students
FOR SELECT TO authenticated USING (public.admin_role() = 'staff');
CREATE POLICY "classroom staff read only" ON public.registrations
FOR SELECT TO authenticated USING (public.admin_role() = 'staff');
CREATE POLICY "classroom staff read only" ON public.registration_dates
FOR SELECT TO authenticated USING (public.admin_role() = 'staff');
CREATE POLICY "classroom staff read only" ON public.attendance_records
FOR SELECT TO authenticated USING (public.admin_role() = 'staff');
CREATE POLICY "classroom staff read only" ON public.closures
FOR SELECT TO authenticated USING (public.admin_role() = 'staff');

-- Full-only operational areas that were previously covered by the broad
-- any-admin predicate.
DROP POLICY IF EXISTS "admin any role" ON public.cacfp_meal_records;
DROP POLICY IF EXISTS "admin any role" ON public.cacfp_menus;
DROP POLICY IF EXISTS "admin any role" ON public.staff_injury_reports;
DROP POLICY IF EXISTS "admin full only" ON public.cacfp_meal_records;
DROP POLICY IF EXISTS "admin full only" ON public.cacfp_menus;
DROP POLICY IF EXISTS "admin full only" ON public.staff_injury_reports;

CREATE POLICY "admin full only" ON public.cacfp_meal_records
FOR ALL TO authenticated USING (public.admin_role() = 'full')
WITH CHECK (public.admin_role() = 'full');
CREATE POLICY "admin full only" ON public.cacfp_menus
FOR ALL TO authenticated USING (public.admin_role() = 'full')
WITH CHECK (public.admin_role() = 'full');
CREATE POLICY "admin full only" ON public.staff_injury_reports
FOR ALL TO authenticated USING (public.admin_role() = 'full')
WITH CHECK (public.admin_role() = 'full');

-- Billing controls must never treat an ordinary authenticated parent session
-- as an administrator session.
DROP POLICY IF EXISTS "Auth access" ON public.billing_credits;
DROP POLICY IF EXISTS "Auth access" ON public.billing_nudges;
DROP POLICY IF EXISTS "Auth access" ON public.billing_payment_plans;
DROP POLICY IF EXISTS "Auth access" ON public.billing_write_offs;

CREATE POLICY "admin full only" ON public.billing_credits
FOR ALL TO authenticated USING (public.admin_role() = 'full')
WITH CHECK (public.admin_role() = 'full');
CREATE POLICY "admin full only" ON public.billing_nudges
FOR ALL TO authenticated USING (public.admin_role() = 'full')
WITH CHECK (public.admin_role() = 'full');
CREATE POLICY "admin full only" ON public.billing_payment_plans
FOR ALL TO authenticated USING (public.admin_role() = 'full')
WITH CHECK (public.admin_role() = 'full');
CREATE POLICY "admin full only" ON public.billing_write_offs
FOR ALL TO authenticated USING (public.admin_role() = 'full')
WITH CHECK (public.admin_role() = 'full');

-- Replace legacy `auth.role() = authenticated` policies. Parent accounts are
-- authenticated too, so authentication alone is not authorization.
DROP POLICY IF EXISTS "Admin insert attendance_summary" ON public.attendance_summary;
DROP POLICY IF EXISTS "Admin read attendance_summary" ON public.attendance_summary;
CREATE POLICY "operational admins manage attendance summary"
ON public.attendance_summary FOR ALL TO authenticated
USING (public.admin_role() IN ('full', 'restricted'))
WITH CHECK (public.admin_role() IN ('full', 'restricted'));
CREATE POLICY "classroom staff read attendance summary"
ON public.attendance_summary FOR SELECT TO authenticated
USING (public.admin_role() = 'staff');

DROP POLICY IF EXISTS "Admin delete billing_summary" ON public.billing_summary;
DROP POLICY IF EXISTS "Admin insert billing_summary" ON public.billing_summary;
DROP POLICY IF EXISTS "Admin read billing_summary" ON public.billing_summary;
DROP POLICY IF EXISTS "Admin update billing_summary" ON public.billing_summary;
CREATE POLICY "admin full only" ON public.billing_summary
FOR ALL TO authenticated USING (public.admin_role() = 'full')
WITH CHECK (public.admin_role() = 'full');

DROP POLICY IF EXISTS "Auth read" ON public.client_error_log;
CREATE POLICY "admin full only read" ON public.client_error_log
FOR SELECT TO authenticated USING (public.admin_role() = 'full');

DROP POLICY IF EXISTS "Admin delete staff_schedules" ON public.staff_schedules;
DROP POLICY IF EXISTS "Admin insert staff_schedules" ON public.staff_schedules;
DROP POLICY IF EXISTS "Admin select staff_schedules" ON public.staff_schedules;
DROP POLICY IF EXISTS "Admin update staff_schedules" ON public.staff_schedules;
CREATE POLICY "operational admins manage staff schedules"
ON public.staff_schedules FOR ALL TO authenticated
USING (public.admin_role() IN ('full', 'restricted'))
WITH CHECK (public.admin_role() IN ('full', 'restricted'));

DROP POLICY IF EXISTS "Auth all" ON public.waitlist_applications;
CREATE POLICY "operational admins manage waitlist"
ON public.waitlist_applications FOR ALL TO authenticated
USING (public.admin_role() IN ('full', 'restricted'))
WITH CHECK (public.admin_role() IN ('full', 'restricted'));

-- Staff-photo mutation is full-admin-only. Public read remains unchanged.
DROP POLICY IF EXISTS "Admin delete staff photos" ON storage.objects;
DROP POLICY IF EXISTS "Admin insert staff photos" ON storage.objects;
DROP POLICY IF EXISTS "Admin update staff photos" ON storage.objects;
CREATE POLICY "full admin delete staff photos" ON storage.objects
FOR DELETE TO authenticated
USING (bucket_id = 'staff-photos' AND public.admin_role() = 'full');
CREATE POLICY "full admin insert staff photos" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'staff-photos' AND public.admin_role() = 'full');
CREATE POLICY "full admin update staff photos" ON storage.objects
FOR UPDATE TO authenticated
USING (bucket_id = 'staff-photos' AND public.admin_role() = 'full')
WITH CHECK (bucket_id = 'staff-photos' AND public.admin_role() = 'full');

-- Privileged finance/HR functions need full-admin checks independent of the
-- broader operational-admin helper.
CREATE OR REPLACE FUNCTION public.center_payment_coverage(p_from date, p_to date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH months AS (
    SELECT to_char(m, 'YYYY-MM') AS month
    FROM generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month') m
  ), days AS (
    SELECT to_char(d.care_date, 'YYYY-MM') AS month, count(*) AS care_days,
           count(DISTINCT r.parent_email) AS families
    FROM registration_dates d JOIN registrations r ON r.id = d.registration_id
    WHERE d.waitlisted IS NOT true AND r.status <> 'cancelled'
      AND d.care_date BETWEEN p_from AND p_to GROUP BY 1
  ), pays AS (
    SELECT to_char(bp.payment_date, 'YYYY-MM') AS month, count(*) AS payments,
           sum(bp.amount) AS paid, count(DISTINCT bp.family_id) AS families_paid
    FROM billing_payments bp WHERE bp.payment_date BETWEEN p_from AND p_to GROUP BY 1
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'month', mo.month, 'care_days', coalesce(d.care_days, 0),
    'families', coalesce(d.families, 0), 'payments', coalesce(p.payments, 0),
    'families_paid', coalesce(p.families_paid, 0), 'paid', coalesce(p.paid, 0)
  ) ORDER BY mo.month), '[]'::jsonb)
  FROM months mo LEFT JOIN days d ON d.month = mo.month
  LEFT JOIN pays p ON p.month = mo.month
  WHERE public.admin_role() = 'full';
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_billing_invoice(p_family_id uuid, p_month character)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(public.admin_role(), '') <> 'full' THEN RAISE EXCEPTION 'Admin access required'; END IF;
  RETURN public._reconcile_billing_invoice_internal(p_family_id, p_month);
END;
$function$;

CREATE OR REPLACE FUNCTION public.import_finalized_billing_invoice(p_family_id uuid, p_month character, p_amount numeric)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_cycle_id bigint; v_id bigint; v_existing_status text; v_existing_amount numeric(10,2);
BEGIN
  IF COALESCE(public.admin_role(), '') <> 'full' THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF p_amount < 0 THEN RAISE EXCEPTION 'Invoice amount cannot be negative'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_family_id::text || ':' || p_month, 0));
  INSERT INTO billing_cycles (month) VALUES (p_month) ON CONFLICT (month) DO NOTHING;
  SELECT id INTO v_cycle_id FROM billing_cycles WHERE month = p_month;
  SELECT id, status, final_amount INTO v_id, v_existing_status, v_existing_amount
  FROM billing_invoices WHERE cycle_id = v_cycle_id AND family_id = p_family_id AND sequence = 1;
  IF v_existing_status = 'finalized' AND v_existing_amount = p_amount THEN RETURN v_id; END IF;
  IF v_existing_status IN ('sent','finalized','paid','partial','void') THEN
    RAISE EXCEPTION 'Import would replace an existing issued invoice';
  END IF;
  INSERT INTO billing_invoices (cycle_id, family_id, base_amount, discount_amount,
    adjustment_amount, adjustment_note, final_amount, status, invoice_type, sequence)
  VALUES (v_cycle_id, p_family_id, p_amount, 0, 0, '', p_amount, 'finalized', 'original', 1)
  ON CONFLICT (cycle_id, family_id, sequence) DO UPDATE
    SET base_amount = EXCLUDED.base_amount, discount_amount = 0,
        adjustment_amount = 0, adjustment_note = '', final_amount = EXCLUDED.final_amount,
        status = 'finalized'
    WHERE billing_invoices.status = 'draft' AND billing_invoices.invoice_type = 'original'
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'Import could not update the existing invoice'; END IF;
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_billing_invoice_draft_amount(p_family_id uuid, p_month character, p_amount numeric)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_cycle_id bigint; v_id bigint;
BEGIN
  IF COALESCE(public.admin_role(), '') <> 'full' THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF p_amount < 0 THEN RAISE EXCEPTION 'Invoice amount cannot be negative'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_family_id::text || ':' || p_month, 0));
  INSERT INTO billing_cycles (month) VALUES (p_month) ON CONFLICT (month) DO NOTHING;
  SELECT id INTO v_cycle_id FROM billing_cycles WHERE month = p_month;
  IF EXISTS (SELECT 1 FROM billing_invoices WHERE cycle_id = v_cycle_id
    AND family_id = p_family_id AND status IN ('sent','finalized','paid','partial','void')) THEN
    RAISE EXCEPTION 'An issued invoice cannot be replaced; create an adjustment instead';
  END IF;
  INSERT INTO billing_invoices (cycle_id, family_id, base_amount, discount_amount,
    adjustment_amount, adjustment_note, final_amount, status, invoice_type, sequence)
  VALUES (v_cycle_id, p_family_id, p_amount, 0, 0, '', p_amount, 'draft', 'original', 1)
  ON CONFLICT (cycle_id, family_id, sequence) DO UPDATE
    SET base_amount = EXCLUDED.base_amount, discount_amount = 0,
        adjustment_amount = 0, adjustment_note = '', final_amount = EXCLUDED.final_amount
    WHERE billing_invoices.status = 'draft' AND billing_invoices.invoice_type = 'original'
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.review_staff_injury_report(
  p_id bigint, p_status text, p_notes text DEFAULT NULL::text, p_claim_ref text DEFAULT NULL::text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_who text;
BEGIN
  IF COALESCE(public.admin_role(), '') <> 'full' THEN RETURN false; END IF;
  IF p_status NOT IN ('reported','acknowledged','filed','closed') THEN RETURN false; END IF;
  v_who := COALESCE(auth.jwt() ->> 'email', 'admin');
  UPDATE staff_injury_reports SET
    status = p_status,
    director_notes = COALESCE(nullif(btrim(p_notes), ''), director_notes),
    insurer_claim_ref = COALESCE(nullif(btrim(p_claim_ref), ''), insurer_claim_ref),
    reviewed_by = v_who,
    reviewed_at = now(),
    insurer_reported_at = CASE WHEN p_status = 'filed' AND insurer_reported_at IS NULL
      THEN now() ELSE insurer_reported_at END
  WHERE id = p_id;
  RETURN FOUND;
END;
$function$;

COMMIT;
