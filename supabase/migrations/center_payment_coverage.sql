-- ============================================================
-- center_payment_coverage() — which months the ledger cannot back
-- ============================================================
-- The childcare statement (family_care_statement.sql) refuses to issue for any
-- month with care days and no payment recorded, because the total under it
-- would be short. That refusal is correct but it surfaces one family at a time,
-- at the worst moment — with a parent waiting.
--
-- This is the same question asked center-wide and up front: for every month in
-- a range, how many care days are on record, how many payments, and how much.
-- The office can see the gap and close it before anybody asks for a document.
--
-- ⚠️ It must use the SAME definition of a care day the statement uses, or the
-- two will disagree and the coverage screen will say a month is fine while the
-- statement refuses it. Non-waitlisted registration_dates on a non-cancelled
-- registration — identical to family_care_statement()'s `days` CTE, minus the
-- per-family filter.
create or replace function public.center_payment_coverage(
    p_from date,
    p_to   date
)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
    with months as (
        select to_char(m, 'YYYY-MM') as month
        from generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month') m
    ),
    days as (
        select to_char(d.care_date, 'YYYY-MM') as month, count(*) as care_days,
               count(distinct r.parent_email) as families
        from registration_dates d
        join registrations r on r.id = d.registration_id
        where d.waitlisted is not true
          and r.status <> 'cancelled'
          and d.care_date between p_from and p_to
        group by 1
    ),
    pays as (
        select to_char(bp.payment_date, 'YYYY-MM') as month,
               count(*) as payments, sum(bp.amount) as paid,
               count(distinct bp.family_id) as families_paid
        from billing_payments bp
        where bp.payment_date between p_from and p_to
        group by 1
    )
    select coalesce(jsonb_agg(jsonb_build_object(
               'month',         mo.month,
               'care_days',     coalesce(d.care_days, 0),
               'families',      coalesce(d.families, 0),
               'payments',      coalesce(p.payments, 0),
               'families_paid', coalesce(p.families_paid, 0),
               'paid',          coalesce(p.paid, 0)
           ) order by mo.month), '[]'::jsonb)
    from months mo
    left join days d on d.month = mo.month
    left join pays p on p.month = mo.month
    where is_admin();
$$;

revoke all on function public.center_payment_coverage(date, date) from public, anon;
grant execute on function public.center_payment_coverage(date, date) to authenticated;
