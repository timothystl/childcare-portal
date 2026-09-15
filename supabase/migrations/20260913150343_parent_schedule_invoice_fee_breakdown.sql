-- Adds a tuition/fee breakdown to each invoice my_schedule() returns to a
-- parent. Purely additive: same signature, same STABLE SECURITY DEFINER,
-- same search_path, same rows readable — two more fields on each invoice
-- object.
--
-- Root cause this closes: billing_invoices.annual_fee_amount (added by
-- 20260903021033_fold_annual_fees_into_invoice_real.sql) records the annual
-- supply/new-family fee folded into an invoice's final_amount, but nothing
-- ever read that column back out to a parent — my_schedule() only returned
-- final_amount as one lump sum, and the parent Billing tab (parent-billing.js)
-- only ever rendered that one number. A family charged $525 tuition + $150
-- supply fee saw a single "$675 Billed" line with no breakdown anywhere on
-- the invoice itself (confirmed live for a real family's September invoice,
-- 2026-09-13).
--
-- tuition_amount is derived here, server-side, from the same authoritative
-- row the rest of this screen already trusts (final_amount), rather than
-- computed client-side — annual_fee_amount is only ever set on the original
-- invoice of a cycle (see _stamp_annual_fees_on_invoice_sent()'s own
-- comment), so on every other invoice row it is 0 and tuition_amount just
-- equals final_amount, which is the correct display either way.
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
        select jsonb_agg(jsonb_build_object('close_date', c.close_date, 'reason', c.reason, 'half_day', c.half_day)
                         order by c.close_date)
        from closures c
        where c.close_date >= (now() at time zone 'America/Chicago')::date - interval '60 days'
      ), '[]'::jsonb),

      'invoices', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', bi.id, 'month', bc.month, 'status', bi.status,
                 'final_amount', bi.final_amount,
                 'annual_fee_amount', bi.annual_fee_amount,
                 'tuition_amount', bi.final_amount - coalesce(bi.annual_fee_amount, 0),
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
