-- BASELINE CAPTURE, applied to production already (dates below are from Supabase's own
-- migration ledger, i.e. what actually ran) -- not a new change. Filed 2026-09-10 after
-- discovering that the entire payroll-proxy RPC surface Website's admin payroll feature
-- depends on (tlc-admin-worker.js's /sb/rest/v1/rpc/payroll_* proxy) was applied straight
-- to this Supabase project and never committed to this repo. Supabase's own ledger records
-- these as already applied:
--   20260818215249 payroll_proxy_rpc
--   20260818215712 payroll_save_staff_active_on_update
--   20260818221710 payroll_proxy_secret_trim_tolerant
--   20260820192657 payroll_get_mdo_period_approval
--   20260820193136 payroll_freeze_rate_per_period_and_ytd
--   20260820193212 payroll_approve_period_drop_narrow_overload
--   20260820201303 payroll_backfill_total_rpc
--   20260801052253 add_payroll_reviews
--   20260801053214 payroll_period_approval_replaces_per_row
-- This file is the reviewable equivalent, captured verbatim from the live definitions via
-- pg_get_functiondef/information_schema (see chms PR history for the read-only queries run).
-- Every statement is idempotent (CREATE OR REPLACE / IF NOT EXISTS), so applying this to the
-- already-live project is a no-op; applying it to a fresh project (disaster recovery, or a
-- future staging environment) reconstructs the same behavior.
--
-- SECURITY REVIEW DONE WHILE CAPTURING THIS (2026-09-10, read-only, no production change):
--   - `private` schema grants USAGE only to `postgres` -- anon/authenticated/service_role
--     all confirmed false. It is not exposed via PostgREST.
--   - private.payroll_proxy_secrets has no RLS and no grants to anon/authenticated/service_role
--     (only postgres) -- unreachable except from inside a SECURITY DEFINER function owned by
--     postgres, which is the intended "credential vault" shape.
--   - Every payroll_* function is SECURITY DEFINER, owned by postgres, and its FIRST action is
--     `if not private.check_payroll_secret(p_secret) then raise exception`. anon has EXECUTE on
--     all of them (required -- Website calls through PostgREST using its anon key), but anon has
--     zero table grants on anything payroll touches, so the shared secret is the only real gate.
--     No service-role key is used anywhere in this path.
--   - payroll_periods and payroll_mdo_rate_snapshot both have RLS enabled. payroll_periods has
--     an explicit admin-only policy; payroll_mdo_rate_snapshot has RLS enabled with zero
--     policies, which is deny-all for every role but the owner -- both are moot for the RPC
--     path itself (SECURITY DEFINER runs as the owner, bypassing RLS), but they correctly deny
--     a direct PostgREST table read by an ordinary authenticated session.
--   - check_payroll_secret does a plain `=` string comparison, not constant-time. Worth
--     hardening later (mirrors the timingSafeEqual pattern already used for chms's own
--     shared-secret checks) but is not being changed in this baseline-capture file.
--
-- Nothing about the running system changes by applying this file. It exists so the next person
-- reading this repo can see, in source control, exactly what "the payroll proxy" does.

create schema if not exists private;
revoke all on schema private from public;

create table if not exists private.payroll_proxy_secrets (
  name         text primary key,
  secret_value text not null
);

create table if not exists public.payroll_periods (
  period_start       date primary key,
  approved_at        timestamptz not null default now(),
  approved_by        text,
  total_gross_cents  bigint
);
alter table public.payroll_periods enable row level security;
drop policy if exists "admin full only" on public.payroll_periods;
create policy "admin full only" on public.payroll_periods
  for all using (admin_role() = 'full') with check (admin_role() = 'full');

create table if not exists public.payroll_mdo_rate_snapshot (
  period_start     date not null,
  staff_id         uuid not null,
  pay_type         text not null,
  hourly_rate      numeric not null default 0,
  salary_biweekly  numeric not null default 0,
  primary key (period_start, staff_id)
);
alter table public.payroll_mdo_rate_snapshot enable row level security;
-- Deliberately no policy: RLS-enabled-with-no-policy denies every role but the table owner.
-- Only the SECURITY DEFINER functions below (owned by postgres) ever read or write this table.

create or replace function private.check_payroll_secret(p_secret text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'private'
as $function$
  select exists (
    select 1 from private.payroll_proxy_secrets
    where name = 'payroll_proxy' and secret_value = trim(both E' \t\r\n' from coalesce(p_secret, ''))
  );
$function$;

create or replace function public.payroll_get_staff(p_secret text)
 returns setof church_staff
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not private.check_payroll_secret(p_secret) then
    raise exception 'invalid secret' using errcode = '28000';
  end if;
  return query select * from public.church_staff where active = true order by name;
end;
$function$;

create or replace function public.payroll_save_staff(p_secret text, p_id uuid, p_name text, p_role text, p_pay_type text, p_hourly_rate numeric, p_base_salary_biweekly numeric, p_housing_allowance_biweekly numeric, p_insurance_opt_out_biweekly numeric, p_hsa_contribution_biweekly numeric, p_mileage_biweekly numeric, p_retirement_403b_type text, p_retirement_403b_amount numeric)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_id uuid;
begin
  if not private.check_payroll_secret(p_secret) then
    raise exception 'invalid secret' using errcode = '28000';
  end if;

  if p_id is not null then
    update public.church_staff set
      name = p_name,
      role = p_role,
      pay_type = p_pay_type,
      hourly_rate = p_hourly_rate,
      base_salary_biweekly = p_base_salary_biweekly,
      housing_allowance_biweekly = p_housing_allowance_biweekly,
      insurance_opt_out_biweekly = p_insurance_opt_out_biweekly,
      hsa_contribution_biweekly = p_hsa_contribution_biweekly,
      mileage_biweekly = p_mileage_biweekly,
      retirement_403b_type = p_retirement_403b_type,
      retirement_403b_amount = p_retirement_403b_amount,
      active = true
    where id = p_id
    returning id into v_id;
  else
    insert into public.church_staff (
      name, role, pay_type, hourly_rate, base_salary_biweekly,
      housing_allowance_biweekly, insurance_opt_out_biweekly,
      hsa_contribution_biweekly, mileage_biweekly,
      retirement_403b_type, retirement_403b_amount, active
    ) values (
      p_name, p_role, p_pay_type, p_hourly_rate, p_base_salary_biweekly,
      p_housing_allowance_biweekly, p_insurance_opt_out_biweekly,
      p_hsa_contribution_biweekly, p_mileage_biweekly,
      p_retirement_403b_type, p_retirement_403b_amount, true
    )
    returning id into v_id;
  end if;

  return v_id;
end;
$function$;

create or replace function public.payroll_deactivate_staff(p_secret text, p_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not private.check_payroll_secret(p_secret) then
    raise exception 'invalid secret' using errcode = '28000';
  end if;
  update public.church_staff set active = false where id = p_id;
end;
$function$;

create or replace function public.payroll_save_hours(p_secret text, p_staff_id uuid, p_period_start date, p_hours_worked numeric, p_pto_used numeric, p_pto_earned numeric)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_staff record;
begin
  if not private.check_payroll_secret(p_secret) then
    raise exception 'invalid secret' using errcode = '28000';
  end if;
  if exists (select 1 from public.payroll_periods where period_start = p_period_start) then
    raise exception 'period is approved and locked' using errcode = '28000';
  end if;

  select * into v_staff from public.church_staff where id = p_staff_id;

  insert into public.church_staff_period_entries
    (staff_id, period_start, hours_worked, pto_hours_used, pto_hours_earned,
     pay_type_used, hourly_rate_used, base_salary_used, housing_allowance_used,
     insurance_opt_out_used, hsa_contribution_used, mileage_used,
     retirement_403b_type_used, retirement_403b_amount_used)
  values
    (p_staff_id, p_period_start, p_hours_worked, p_pto_used, p_pto_earned,
     v_staff.pay_type, v_staff.hourly_rate, v_staff.base_salary_biweekly, v_staff.housing_allowance_biweekly,
     v_staff.insurance_opt_out_biweekly, v_staff.hsa_contribution_biweekly, v_staff.mileage_biweekly,
     v_staff.retirement_403b_type, v_staff.retirement_403b_amount)
  on conflict (staff_id, period_start) do update set
    hours_worked = excluded.hours_worked,
    pto_hours_used = excluded.pto_hours_used,
    pto_hours_earned = excluded.pto_hours_earned,
    pay_type_used = excluded.pay_type_used,
    hourly_rate_used = excluded.hourly_rate_used,
    base_salary_used = excluded.base_salary_used,
    housing_allowance_used = excluded.housing_allowance_used,
    insurance_opt_out_used = excluded.insurance_opt_out_used,
    hsa_contribution_used = excluded.hsa_contribution_used,
    mileage_used = excluded.mileage_used,
    retirement_403b_type_used = excluded.retirement_403b_type_used,
    retirement_403b_amount_used = excluded.retirement_403b_amount_used;
end;
$function$;

create or replace function public.payroll_get_period_entries(p_secret text, p_period_start date)
 returns setof church_staff_period_entries
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not private.check_payroll_secret(p_secret) then
    raise exception 'invalid secret' using errcode = '28000';
  end if;
  return query
    select * from public.church_staff_period_entries
    where period_start = p_period_start;
end;
$function$;

create or replace function public.payroll_get_prior_pto(p_secret text, p_period_start date)
 returns table(staff_id uuid, pto_hours_earned numeric, pto_hours_used numeric)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not private.check_payroll_secret(p_secret) then
    raise exception 'invalid secret' using errcode = '28000';
  end if;
  return query
    select e.staff_id, e.pto_hours_earned, e.pto_hours_used
    from public.church_staff_period_entries e
    where e.period_start < p_period_start;
end;
$function$;

create or replace function public.payroll_approve_period(p_secret text, p_period_start date, p_approved_by text, p_total_gross_cents bigint default null::bigint)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not private.check_payroll_secret(p_secret) then
    raise exception 'invalid secret' using errcode = '28000';
  end if;

  insert into public.church_staff_period_entries
    (staff_id, period_start, hours_worked, pto_hours_used, pto_hours_earned,
     pay_type_used, hourly_rate_used, base_salary_used, housing_allowance_used,
     insurance_opt_out_used, hsa_contribution_used, mileage_used,
     retirement_403b_type_used, retirement_403b_amount_used)
  select s.id, p_period_start, 0, 0, 0,
     s.pay_type, s.hourly_rate, s.base_salary_biweekly, s.housing_allowance_biweekly,
     s.insurance_opt_out_biweekly, s.hsa_contribution_biweekly, s.mileage_biweekly,
     s.retirement_403b_type, s.retirement_403b_amount
  from public.church_staff s
  where s.active = true
  on conflict (staff_id, period_start) do nothing;

  insert into public.payroll_mdo_rate_snapshot (period_start, staff_id, pay_type, hourly_rate, salary_biweekly)
  select p_period_start, s.id, s.pay_type, s.hourly_rate, s.salary_biweekly
  from public.staff s
  where s.active = true
  on conflict (period_start, staff_id) do nothing;

  insert into public.payroll_periods (period_start, approved_by, total_gross_cents)
  values (p_period_start, p_approved_by, p_total_gross_cents)
  on conflict (period_start) do update set
    approved_by = excluded.approved_by,
    total_gross_cents = excluded.total_gross_cents;
end;
$function$;

create or replace function public.payroll_unapprove_period(p_secret text, p_period_start date)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not private.check_payroll_secret(p_secret) then
    raise exception 'invalid secret' using errcode = '28000';
  end if;

  delete from public.church_staff_period_entries
  where period_start = p_period_start
    and hours_worked = 0 and pto_hours_used = 0 and pto_hours_earned = 0;

  delete from public.payroll_mdo_rate_snapshot where period_start = p_period_start;

  delete from public.payroll_periods where period_start = p_period_start;
end;
$function$;

create or replace function public.payroll_get_period_approval(p_secret text, p_period_start date)
 returns setof payroll_periods
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not private.check_payroll_secret(p_secret) then
    raise exception 'invalid secret' using errcode = '28000';
  end if;
  return query
    select * from public.payroll_periods
    where period_start = p_period_start;
end;
$function$;

create or replace function public.payroll_backfill_total(p_secret text, p_period_start date, p_total_gross_cents bigint)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not private.check_payroll_secret(p_secret) then
    raise exception 'invalid secret' using errcode = '28000';
  end if;
  update public.payroll_periods
  set total_gross_cents = p_total_gross_cents
  where period_start = p_period_start
    and total_gross_cents is null;
end;
$function$;

create or replace function public.payroll_get_year_totals(p_secret text, p_year integer)
 returns table(period_start date, approved_at timestamptz, approved_by text, total_gross_cents bigint)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not private.check_payroll_secret(p_secret) then
    raise exception 'invalid secret' using errcode = '28000';
  end if;
  return query
    select pp.period_start, pp.approved_at, pp.approved_by, pp.total_gross_cents
    from public.payroll_periods pp
    where extract(year from pp.period_start) = p_year
    order by pp.period_start;
end;
$function$;

create or replace function public.payroll_get_mdo_staff(p_secret text)
 returns table(id uuid, name text, role text, pay_type text, hourly_rate numeric, salary_biweekly numeric, room_id text, active boolean)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not private.check_payroll_secret(p_secret) then
    raise exception 'invalid secret' using errcode = '28000';
  end if;
  return query
    select s.id, s.name, s.role, s.pay_type, s.hourly_rate, s.salary_biweekly, s.room_id, s.active
    from public.staff s
    where s.active = true
    order by s.name;
end;
$function$;

create or replace function public.payroll_get_mdo_hours(p_secret text, p_start date, p_end date)
 returns table(staff_id uuid, work_date date, hours_worked numeric)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not private.check_payroll_secret(p_secret) then
    raise exception 'invalid secret' using errcode = '28000';
  end if;
  return query
    select h.staff_id, h.work_date, h.hours_worked
    from public.staff_hours h
    where h.work_date between p_start and p_end;
end;
$function$;

create or replace function public.payroll_get_mdo_clock_events(p_secret text, p_start date, p_end date)
 returns table(staff_id uuid, clock_in timestamptz, clock_out timestamptz, work_date date)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not private.check_payroll_secret(p_secret) then
    raise exception 'invalid secret' using errcode = '28000';
  end if;
  return query
    select c.staff_id, c.clock_in, c.clock_out, c.work_date
    from public.staff_clock_events c
    where c.work_date between p_start and p_end;
end;
$function$;

create or replace function public.payroll_get_mdo_pto(p_secret text, p_period_start date)
 returns table(staff_id uuid, pto_hours_used numeric)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not private.check_payroll_secret(p_secret) then
    raise exception 'invalid secret' using errcode = '28000';
  end if;
  return query
    select p.staff_id, p.pto_hours_used
    from public.staff_pto_entries p
    where p.period_start = p_period_start;
end;
$function$;

create or replace function public.payroll_get_mdo_rate_snapshot(p_secret text, p_period_start date)
 returns setof payroll_mdo_rate_snapshot
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not private.check_payroll_secret(p_secret) then
    raise exception 'invalid secret' using errcode = '28000';
  end if;
  return query
    select * from public.payroll_mdo_rate_snapshot
    where period_start = p_period_start;
end;
$function$;

create or replace function public.payroll_get_mdo_period_approval(p_secret text, p_period_start date)
 returns setof mdo_payroll_approvals
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not private.check_payroll_secret(p_secret) then
    raise exception 'invalid secret' using errcode = '28000';
  end if;
  return query
    select * from public.mdo_payroll_approvals
    where period_start = p_period_start;
end;
$function$;

-- Matches the live grants exactly: anon needs EXECUTE on every function here because Website
-- calls through PostgREST using its anon key (the shared secret inside the function body is
-- the real gate, not role membership). authenticated has it too, except on
-- payroll_get_mdo_period_approval, matching production as found.
grant execute on function
  public.payroll_get_staff(text),
  public.payroll_save_staff(text, uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, numeric, text, numeric),
  public.payroll_deactivate_staff(text, uuid),
  public.payroll_save_hours(text, uuid, date, numeric, numeric, numeric),
  public.payroll_get_period_entries(text, date),
  public.payroll_get_prior_pto(text, date),
  public.payroll_approve_period(text, date, text, bigint),
  public.payroll_unapprove_period(text, date),
  public.payroll_get_period_approval(text, date),
  public.payroll_backfill_total(text, date, bigint),
  public.payroll_get_year_totals(text, integer),
  public.payroll_get_mdo_staff(text),
  public.payroll_get_mdo_hours(text, date, date),
  public.payroll_get_mdo_clock_events(text, date, date),
  public.payroll_get_mdo_pto(text, date),
  public.payroll_get_mdo_rate_snapshot(text, date)
  to anon, authenticated;

grant execute on function public.payroll_get_mdo_period_approval(text, date) to anon;
