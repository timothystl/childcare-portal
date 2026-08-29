-- ============================================================
-- family_care_statement() — the year-end / period childcare statement
-- ============================================================
-- What a parent hands to their tax preparer (IRS Form 2441) or to an employer
-- running a dependent-care reimbursement account. Three periods are supported
-- by the callers: one month, year to date, or a whole calendar year — all of
-- them just a from/to pair here.
--
-- ⚠️ ONE STATEMENT PER FAMILY, listing every child who attended. The mockup
-- named a single child, but billing_payments has NO student_id — money is
-- recorded against the family. Splitting a family total between siblings would
-- put a number this app invented on a document filed with the IRS. Form 2441
-- wants the provider, the amount paid to them, and the qualifying persons,
-- which is exactly what this returns.
--
-- ⚠️ TOTAL PAID IS MONEY RECEIVED, never money billed. It sums
-- billing_payments over the period, which is what "paid for care" means on a
-- tax document. Refunds are stored as their own rows and are summed in, so a
-- reversal reduces the total rather than being silently dropped.
--
-- ⚠️ THE COVERAGE BLOCK IS NOT DECORATION. Production today has care days in
-- July and August 2026 and ZERO payments recorded in either month, and
-- registration_dates does not reach back before April 2026 while payments
-- start in January. So both headline numbers can be short, in opposite
-- directions, for reasons that have nothing to do with the family. Every month
-- in the period is returned with its own care-day and payment counts so the
-- caller can refuse to issue, or warn, rather than printing a confident wrong
-- total. Do not drop it to tidy the payload.
--
-- ⚠️ A REGISTRATION HAS NO family_id. It is matched to a family by
-- parent_email against families.parent_email / parent2_email, which is the
-- same join my_schedule() uses. Reusing it is what keeps this statement and
-- the parent's own Schedule tab from disagreeing about which days were care
-- days. If that link ever becomes a real foreign key, change both together.
create or replace function public.family_care_statement(
    p_family_id uuid,
    p_from      date,
    p_to        date
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    v_provider jsonb := '{}'::jsonb;
    v_raw      text;
    v_out      jsonb;
begin
    if p_family_id is null or p_from is null or p_to is null or p_to < p_from then
        return 'null'::jsonb;
    end if;

    -- The office, or the family itself. A parent asking for another family's
    -- statement gets null — the id is never trusted.
    if not (is_admin() or p_family_id in (select parent_family_ids())) then
        return 'null'::jsonb;
    end if;

    -- ⚠️ settings.value is a TEXT column that may hold bare text OR json (the
    -- T3 trap). Never cast it blind.
    select s.value into v_raw from settings s where s.key = 'provider_tax_info';
    if v_raw is not null then
        begin
            v_provider := v_raw::jsonb;
            if jsonb_typeof(v_provider) <> 'object' then v_provider := '{}'::jsonb; end if;
        exception when others then
            v_provider := '{}'::jsonb;
        end;
    end if;

    with fam as (
        select f.id, f.parent_name, f.parent_email, f.parent2_name, f.parent2_email
        from families f where f.id = p_family_id
    ),
    -- Every non-cancelled registration belonging to this family, by the same
    -- email match my_schedule() uses.
    regs as (
        select r.id, r.child_name, r.room_id
        from registrations r, fam f
        where r.status <> 'cancelled'
          and (lower(r.parent_email) = lower(f.parent_email)
            or (coalesce(f.parent2_email,'') <> ''
                and lower(r.parent_email) = lower(f.parent2_email)))
    ),
    days as (
        select d.care_date, rg.child_name, rg.room_id
        from registration_dates d join regs rg on rg.id = d.registration_id
        where d.waitlisted is not true
          and d.care_date between p_from and p_to
    ),
    pays as (
        select bp.payment_date, bp.amount, bp.payment_method, bp.processor
        from billing_payments bp
        where bp.family_id = p_family_id
          and bp.payment_date between p_from and p_to
    ),
    months as (
        select to_char(m, 'YYYY-MM') as month, m::date as month_start
        from generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month') m
    )
    select jsonb_build_object(
        'provider', v_provider,
        'family', (select jsonb_build_object(
                       'id', f.id, 'parent_name', f.parent_name,
                       'parent_email', f.parent_email, 'parent2_name', f.parent2_name)
                   from fam f),
        'period', jsonb_build_object(
            'from', p_from, 'to', p_to,
            'first_care_date', (select min(care_date) from days),
            'last_care_date',  (select max(care_date) from days)),
        'children', coalesce((
            select jsonb_agg(x order by x->>'child_name')
            from (select jsonb_build_object(
                      'child_name', d.child_name,
                      'days', count(*),
                      'rooms', (select jsonb_agg(distinct d2.room_id)
                                from days d2 where d2.child_name = d.child_name)) as x
                  from days d group by d.child_name) c
        ), '[]'::jsonb),
        'days_of_care', (select count(*) from days),
        'total_paid',   coalesce((select sum(amount) from pays), 0),
        'payments', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'payment_date', p.payment_date, 'amount', p.amount,
                       'payment_method', coalesce(p.processor, p.payment_method))
                   order by p.payment_date)
            from pays p), '[]'::jsonb),
        -- One row per month in the period: what the ledger actually holds.
        'coverage', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'month', mo.month,
                       'care_days', (select count(*) from days d
                                      where to_char(d.care_date,'YYYY-MM') = mo.month),
                       'payments',  (select count(*) from pays p
                                      where to_char(p.payment_date,'YYYY-MM') = mo.month),
                       'paid', coalesce((select sum(p.amount) from pays p
                                          where to_char(p.payment_date,'YYYY-MM') = mo.month), 0))
                   order by mo.month)
            from months mo), '[]'::jsonb)
    ) into v_out;

    return coalesce(v_out, 'null'::jsonb);
end;
$$;

revoke all on function public.family_care_statement(uuid, date, date) from public, anon;
grant execute on function public.family_care_statement(uuid, date, date) to authenticated;
