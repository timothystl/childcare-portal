-- MDO-side payroll approval, read by the church admin app (timothystl/website)
-- over its own payroll_get_mdo_period_approval RPC.
--
-- This is a SEPARATE fact from public.payroll_periods. payroll_periods is
-- written by the website's own admin app and means "the combined church+MDO
-- payroll run for this period was signed off" — it is keyed only on
-- period_start and has no idea whether the MDO director has actually reviewed
-- her own staff's hours. This table is that missing signal: the MDO director
-- reviews staff_hours/staff_clock_events for a period in THIS app's own
-- Payroll report and marks it approved, independently of whatever the church
-- side has or hasn't done. The website reads it as a separate status, never
-- merges it into payroll_periods, and never writes to it.
--
-- period_start must match the church app's own biweekly period_start values
-- (both sides already agree on the boundaries — payroll_get_mdo_hours/
-- payroll_get_mdo_clock_events are already queried by the same start/end a
-- church period uses) or the two apps will be talking about different weeks.
create table if not exists public.mdo_payroll_approvals (
    period_start date primary key,
    approved_at  timestamptz not null default now(),
    approved_by  text not null
);

alter table public.mdo_payroll_approvals enable row level security;

-- Supabase grants ALL on a new public table to anon and authenticated by
-- default at creation time — invisible in this file otherwise (see the
-- admin_push_subscriptions TRUNCATE finding in CLAUDE.md). Revoke first,
-- then grant back only what authenticated needs; RLS narrows it further.
revoke all on public.mdo_payroll_approvals from anon, authenticated, public;

grant select, insert, update, delete on public.mdo_payroll_approvals to authenticated;

-- Gated on admin_role() = 'full', not is_admin() — this names an employee's
-- pay the same way staff/staff_hours/staff_pto_entries already do, and the
-- Payroll report itself is AP_FULL_ONLY_KEYS-gated in the UI. Match the two.
create policy "full admin only" on public.mdo_payroll_approvals
    for all
    to authenticated
    using (admin_role() = 'full')
    with check (admin_role() = 'full');
