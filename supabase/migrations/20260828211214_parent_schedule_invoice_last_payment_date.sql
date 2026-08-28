-- Adds last_payment_date to each invoice my_schedule() returns to a parent.
-- Purely additive: same signature, same STABLE SECURITY DEFINER, same
-- search_path, same rows readable — one more computed field in the jsonb
-- payload. Needed so the redesigned Billing tab (portal-billing.js) can show
-- "Payment date" on an invoice without a second round trip or exposing the
-- individual billing_payments rows (which carry payment_method/notes the
-- parent app has no reason to see).
--
-- Read-only aggregate (max(payment_date) for that invoice) — no new grants,
-- no new table exposed, nothing writable added.
create or replace function public.my_schedule()
returns jsonb
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
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

      'closures', coalesce((
        select jsonb_agg(jsonb_build_object('close_date', c.close_date, 'reason', c.reason)
                         order by c.close_date)
        from closures c
        where c.close_date >= (now() at time zone 'America/Chicago')::date - interval '60 days'
      ), '[]'::jsonb),

      'invoices', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', bi.id, 'month', bc.month, 'status', bi.status,
                 'final_amount', bi.final_amount,
                 'paid_amount', coalesce((
                     select sum(bp.amount) from billing_payments bp
                     where bp.invoice_id = bi.id), 0),
                 'last_payment_date', (
                     select max(bp.payment_date) from billing_payments bp
                     where bp.invoice_id = bi.id),
                 'sent_at', bi.sent_at)
                 order by bc.month)
        from billing_invoices bi join billing_cycles bc on bc.id = bi.cycle_id
        where bi.family_id = v_fam and bi.status <> 'void'
      ), '[]'::jsonb)
    ) into v_out;

    return coalesce(v_out, 'null'::jsonb);
end;
$function$;
