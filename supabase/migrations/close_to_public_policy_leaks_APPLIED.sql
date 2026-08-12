-- APPLIED TO PRODUCTION 2026-08-12. Three migrations, recorded together
-- because they were one investigation:
--   close_to_public_policy_leaks
--   close_to_public_policy_leaks_followup
--   revoke_unbacked_anon_grants
--
-- FOUND BY portal.html?check=1 — the first time anything asked these questions
-- AS a real non-admin authenticated session rather than reasoning about them
-- from the catalog. Three tables answered a parent: staff, staff_hours,
-- staff_clock_events.
--
-- ROOT CAUSE. `TO public` means EVERY role — anon AND authenticated. Policies
-- named "anon read" / "Anon PIN lookup" / "Anon clock read" were written
-- `TO public`, so the policy-scoping sweep read them as anon-only and left
-- them. They were never anon-only. Same trap as R26/R27 ("revoking anon alone
-- is insufficient, the PUBLIC grant is inherited") but on the POLICY side.
-- Option B then widened the blast radius: parents now hold `authenticated`.
--
-- VERIFIED AFTER APPLYING, as the roles themselves:
--   parent (authenticated, not in admin_roles) -> is_admin() false; 0 rows from
--     staff, staff_hours, staff_clock_events, church_staff, payroll_periods,
--     staff_pto_entries, church_staff_period_entries
--   anon -> permission denied on church_staff; still reads settings (13),
--     closures (12), staff display cols (31), staff_clock_events (1515)
--   anon kiosk clock-in + clock-out round trip still works (rolled back)
--   admin mdo@timothystl.org (full) -> still sees all 36/151/1515/10/2/3

DROP POLICY IF EXISTS "Anon PIN lookup" ON public.staff;
DROP POLICY IF EXISTS "anon read"       ON public.staff;
DROP POLICY IF EXISTS "anon read"       ON public.staff_hours;

-- staff_clock_events carried THREE overlapping public SELECT policies, not two.
-- The first pass dropped one by name; re-running the catalog sweep caught the
-- other. The TO anon policies are what the kiosk rides and are untouched.
DROP POLICY IF EXISTS "Anon clock read"   ON public.staff_clock_events;
DROP POLICY IF EXISTS "Anon clock write"  ON public.staff_clock_events;
DROP POLICY IF EXISTS "Anon clock update" ON public.staff_clock_events;
DROP POLICY IF EXISTS "anon read"         ON public.staff_clock_events;

-- Church payroll: worse than the check panel found. These four never appeared
-- in the earlier scoping sweep and carried a bare `allow all` USING (true) FOR
-- ALL TO public, with anon holding full CRUD grants. The public anon key could
-- read and rewrite church payroll (10 staff, 3 period entries, 2 periods).
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['church_staff','church_staff_period_entries',
                             'payroll_periods','staff_pto_entries']
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS "allow all" ON public.%I', t);
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
        EXECUTE format(
            'CREATE POLICY "admin full only" ON public.%I FOR ALL TO authenticated '
            'USING (admin_role() = ''full'') WITH CHECK (admin_role() = ''full'')', t);
    END LOOP;
END $$;

DROP POLICY IF EXISTS "anon read" ON public.staff_pto_entries;  -- dead after the revoke

-- ── Defence in depth: revoke anon grants no policy backs ─────
-- All of these have RLS on and no policy anon can satisfy, so anon cannot
-- reach them today — the grants are inert. That is exactly what made the leak
-- possible: grants sat for months, and one permissive policy made them live.
-- Safe by construction — any request these would block is already failing.
--
-- EXCLUDED: settings, cacfp_menus, closures, staff (narrow anon policies the
-- public pages use); families, students, registrations, registration_dates,
-- messages, deletion_requests, waitlist_applications, client_error_log (anon
-- INSERT is the public registration/waitlist/contact/error path — and their
-- SELECT grant must stay, because PostgREST issues INSERT ... RETURNING);
-- staff_clock_events (the kiosk).
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'attendance_summary',
        'billing_cycles', 'billing_import_batches', 'billing_invoices',
        'billing_overrides', 'billing_payments', 'billing_summary',
        'cacfp_claim_lines', 'cacfp_claim_periods', 'cacfp_income_applications',
        'cacfp_meal_records', 'cacfp_reimbursement_rates',
        'family_rates', 'market_providers', 'pin_reset_tokens',
        'push_subscriptions', 'staff_clock_notifications',
        'staff_push_subscriptions', 'staff_schedules'
    ]
    LOOP
        EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END LOOP;
END $$;

-- Left alone deliberately: client_error_log "Public insert" and
-- waitlist_applications "Public insert" are INSERT-only with no read path.
-- Narrowing them to TO anon would strip the admin's own insert path.
