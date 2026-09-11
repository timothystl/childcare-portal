-- Prevents the annual supply fee and one-time new-family fee from being
-- baked into more than one month's draft invoice at once.
--
-- Root cause this closes: _family_month_annual_fees() decided "does this
-- family/child still owe the fee this cycle?" purely from whether
-- reg_fee_paid_year / new_family_fee_charged had been stamped, and that
-- stamp only happens when an invoice is actually SENT (see
-- _stamp_annual_fees_on_invoice_sent(), added in
-- fold_annual_fees_into_invoice_real). Drafting a later month (e.g. October)
-- before an earlier month's invoice (September) that already carries the fee
-- has actually been sent leaves both drafts independently "not yet stamped,"
-- so both compute the fee as owed -- a real double charge if both are ever
-- sent. Confirmed live 2026-09-10: 32 October originals had picked up a
-- supply/new-family fee already carried by that same family's September
-- original, while neither had been sent. Verified the fix directly against
-- production data (read-only, via a throwaway test copy of this function)
-- before replacing the real one: every existing family's fee traces to
-- exactly one month, and the two families with no September invoice at all
-- correctly land on October as their true first month.
--
-- Fix: derive "which month owns this fee" directly from the family's actual
-- care days instead of a stamp that only lands at send time. The reg fee
-- belongs to the first month within the current fee cycle that a child has a
-- real, confirmed, non-waitlisted care day; the new-family fee (a true
-- one-time fee, not annual) belongs to the family's first such month ever.
-- Whichever month that is, it owns the fee -- no matter which month's draft
-- gets built or sent first, and no matter how many months ahead get drafted
-- before any of them are sent. The reg_fee_paid_year / new_family_fee_charged
-- stamps (set at send time) still short-circuit this for anyone already
-- actually billed in a prior cycle/ever, and remain the permanent record once
-- an invoice is sent.
create or replace function public._family_month_annual_fees(p_family_id uuid, p_month text)
returns table(reg_fee numeric, new_family_fee numeric, owing_student_ids uuid[],
              owes_new_family_fee boolean, cycle_year int)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
    v_month_start date;
    v_month_end   date;
    v_reg_fee_amount   numeric;
    v_new_family_fee   numeric;
    v_supply_fee_max   numeric;
    v_renewal_md       text;
    v_today_md         text;
    v_cycle_year       int;
    v_cycle_start      date;
    v_cycle_end        date;
    v_owed_ids         uuid[];
    v_raw_supply       numeric;
    v_reg_fee          numeric;
    v_owes_new_family  boolean;
begin
    v_month_start := (p_month || '-01')::date;
    v_month_end   := (v_month_start + interval '1 month')::date;

    select nullif(regexp_replace(coalesce(value, ''), '[^0-9.]', '', 'g'), '')::numeric
      into v_reg_fee_amount from settings where key = 'registration_fee';
    select nullif(regexp_replace(coalesce(value, ''), '[^0-9.]', '', 'g'), '')::numeric
      into v_new_family_fee from settings where key = 'new_family_fee';
    select nullif(regexp_replace(coalesce(value, ''), '[^0-9.]', '', 'g'), '')::numeric
      into v_supply_fee_max from settings where key = 'supply_fee_family_max';
    select value into v_renewal_md from settings where key = 'registration_fee_renewal_date';

    v_reg_fee_amount := coalesce(v_reg_fee_amount, 0);
    v_new_family_fee := coalesce(v_new_family_fee, 0);
    v_supply_fee_max := coalesce(v_supply_fee_max, 0);
    if v_renewal_md !~ '^\d{2}-\d{2}$' then v_renewal_md := '01-01'; end if;

    v_today_md   := to_char(now() at time zone 'America/Chicago', 'MM-DD');
    v_cycle_year := extract(year from (now() at time zone 'America/Chicago'))::int;
    if v_today_md < v_renewal_md then v_cycle_year := v_cycle_year - 1; end if;

    v_cycle_start := make_date(v_cycle_year, split_part(v_renewal_md, '-', 1)::int, split_part(v_renewal_md, '-', 2)::int);
    v_cycle_end   := (v_cycle_start + interval '1 year')::date;

    -- Children of this family who have a real, non-waitlisted care day in
    -- THIS month, haven't already been stamped paid for this cycle, and for
    -- whom this month is the EARLIEST month within the current cycle that
    -- has such a day -- so the fee lands on exactly one month's bill.
    with student_first_month as (
        select s.id as student_id,
               min(date_trunc('month', rd.care_date))::date as first_month
          from students s
          join families f on f.id = s.family_id
          join registrations r
            on lower(trim(r.child_name)) = lower(trim(s.child_name))
           and (lower(trim(r.parent_email)) = lower(trim(f.parent_email))
             or (coalesce(f.parent2_email, '') <> ''
                 and lower(trim(r.parent_email)) = lower(trim(f.parent2_email))))
          join registration_dates rd on rd.registration_id = r.id
         where f.id = p_family_id
           and r.status = 'confirmed'
           and coalesce(rd.waitlisted, false) = false
           and rd.care_date >= v_cycle_start
           and rd.care_date <  v_cycle_end
         group by s.id
    )
    select array_agg(distinct s.id)
      into v_owed_ids
      from students s
      join student_first_month sfm on sfm.student_id = s.id
     where s.family_id = p_family_id
       and (s.reg_fee_paid_year is null or s.reg_fee_paid_year <> v_cycle_year)
       and sfm.first_month = v_month_start;

    v_raw_supply := coalesce(array_length(v_owed_ids, 1), 0) * v_reg_fee_amount;
    v_reg_fee := case when v_supply_fee_max > 0 and v_raw_supply > v_supply_fee_max
                       then v_supply_fee_max else v_raw_supply end;
    if v_reg_fee_amount <= 0 then v_reg_fee := 0; v_owed_ids := null; end if;

    -- New-family fee: a true one-time fee, so it belongs to the family's
    -- actual first-ever real, confirmed, non-waitlisted care month (not
    -- scoped to the current cycle) -- the same single-month gate as above.
    select (v_new_family_fee > 0 and not f.new_family_fee_charged)
        and v_month_start = (
            select date_trunc('month', min(rd2.care_date))::date
              from registrations r2
              join registration_dates rd2 on rd2.registration_id = r2.id
             where r2.status = 'confirmed'
               and (lower(trim(r2.parent_email)) = lower(trim(f.parent_email))
                 or (coalesce(f.parent2_email, '') <> ''
                     and lower(trim(r2.parent_email)) = lower(trim(f.parent2_email))))
               and coalesce(rd2.waitlisted, false) = false
        )
      into v_owes_new_family
      from families f where f.id = p_family_id;

    return query select
        v_reg_fee,
        case when coalesce(v_owes_new_family, false) then v_new_family_fee else 0 end,
        v_owed_ids,
        coalesce(v_owes_new_family, false),
        v_cycle_year;
end;
$function$;

revoke all on function public._family_month_annual_fees(uuid, text) from public, anon, authenticated;
