-- ============================================================
-- PARENT BILLING TAB — my_schedule() invoice fields + an anon-grant fix
-- ============================================================
-- Applied directly via the Supabase MCP tool (live DB), 2026-08-17.
--
-- ⚠️ my_schedule() ALREADY EXISTED IN PRODUCTION WITH NO MIGRATION FILE.
-- It was created directly in the SQL editor at some point — exactly the
-- "committed migration ≠ deployed one" trap this file usually warns about,
-- run in reverse: a *deployed* function with nothing committed for the next
-- person to find. This file is that missing record, plus two real additions.
--
-- 1. Adds `id` and `paid_amount` to the `invoices` array my_schedule()
--    already returns. The Schedule tab (portal-schedule.js) doesn't read
--    either field and keeps working unchanged; the new Billing tab
--    (portal-billing.js) needs both — id to link a "Pay" placeholder to a
--    specific invoice, paid_amount (summed live from billing_payments) to
--    show a balance due for a 'partial' invoice instead of the full amount.
--
-- 2. ⚠️ my_schedule() and my_account() were BOTH anon-executable — the same
--    Supabase default-grant leftover documented elsewhere in this repo
--    (R26/R27, fs1_phase1_narrow_anon_staff_columns, …): a new function
--    grants EXECUTE to anon and authenticated unless revoked by hand.
--    Verified harmless in practice (both resolve everything from
--    my_parent_context(), which reads auth.uid() and returns 'null' for an
--    unauthenticated caller — an anon call returns nothing), but per this
--    repo's own standard an unauthenticated caller should never hold EXECUTE
--    on a signed-in-parent-only function. Revoked from both here.

CREATE OR REPLACE FUNCTION public.my_schedule()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_fam uuid; v_out jsonb;
begin
    v_fam := (my_parent_context()->>'family_id')::uuid;
    if v_fam is null then return 'null'::jsonb; end if;

    select jsonb_build_object(
      'registrations', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', r.id, 'status', r.status, 'child_name', r.child_name,
                 'room_id', r.room_id, 'month_key', r.month_key,
                 'dates', coalesce((
                     select jsonb_agg(jsonb_build_object(
                         'care_date', d.care_date, 'waitlisted', d.waitlisted,
                         'day_type', d.day_type, 'room_id', d.room_id,
                         'change_fee', d.change_fee) order by d.care_date)
                     from registration_dates d where d.registration_id = r.id), '[]'::jsonb))
               order by r.child_name, r.month_key)
        from registrations r, families f
        where f.id = v_fam
          and r.status <> 'cancelled'
          and (lower(r.parent_email) = lower(f.parent_email)
            or (coalesce(f.parent2_email,'') <> '' and lower(r.parent_email) = lower(f.parent2_email)))
      ), '[]'::jsonb),

      -- Only forward-looking closures matter to a schedule the parent is
      -- reading now; the whole table would be years of history.
      'closures', coalesce((
        select jsonb_agg(jsonb_build_object('close_date', c.close_date, 'reason', c.reason)
                         order by c.close_date)
        from closures c
        where c.close_date >= (now() at time zone 'America/Chicago')::date - interval '60 days'
      ), '[]'::jsonb),

      -- Real invoices only. No row for a month simply means nothing has been
      -- issued, which is currently every month. id + paid_amount added for
      -- the Billing tab — see the note at the top of this file.
      'invoices', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', bi.id, 'month', bc.month, 'status', bi.status,
                 'final_amount', bi.final_amount,
                 'paid_amount', coalesce((
                     select sum(bp.amount) from billing_payments bp
                     where bp.invoice_id = bi.id), 0),
                 'sent_at', bi.sent_at)
                 order by bc.month)
        from billing_invoices bi join billing_cycles bc on bc.id = bi.cycle_id
        where bi.family_id = v_fam and bi.status <> 'void'
      ), '[]'::jsonb)
    ) into v_out;

    return coalesce(v_out, 'null'::jsonb);
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.my_schedule() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.my_schedule() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.my_account() FROM PUBLIC, anon;

-- ============================================================
-- VERIFY (run after applying)
-- ============================================================
--   SELECT grantee, privilege_type FROM information_schema.routine_privileges
--    WHERE routine_name IN ('my_schedule','my_account');
--   → anon must NOT appear for either; authenticated must appear for both.
--
--   As the authenticated parent role, in a rolled-back transaction:
--   SELECT my_schedule()->'invoices';
--   → each element carries id and paid_amount alongside the existing
--     month/status/final_amount/sent_at.
-- ============================================================
