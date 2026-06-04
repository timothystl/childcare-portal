-- Church staff payroll tables — completely separate from MDO staff table.
-- Apply in Supabase SQL Editor.

create table if not exists church_staff (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null,
  role                        text,
  pay_type                    text not null check (pay_type in ('hourly','salary')),
  hourly_rate                 numeric(10,2) not null default 0,
  base_salary_biweekly        numeric(10,2) not null default 0,
  housing_allowance_biweekly  numeric(10,2) not null default 0,
  insurance_opt_out_biweekly  numeric(10,2) not null default 0,
  hsa_contribution_biweekly   numeric(10,2) not null default 0,
  mileage_biweekly            numeric(10,2) not null default 0,
  retirement_403b_type        text not null default 'fixed' check (retirement_403b_type in ('fixed','percent')),
  retirement_403b_amount      numeric(10,4) not null default 0,
  active                      boolean not null default true,
  created_at                  timestamptz default now()
);

-- Per-period variable data for hourly staff (hours worked, PTO used/earned).
-- Salary staff have no rows here — their pay is fully static.
create table if not exists church_staff_period_entries (
  id              uuid primary key default gen_random_uuid(),
  staff_id        uuid not null references church_staff(id) on delete cascade,
  period_start    date not null,
  hours_worked    numeric(6,2) not null default 0,
  pto_hours_used  numeric(6,2) not null default 0,
  pto_hours_earned numeric(6,2) not null default 0,
  unique(staff_id, period_start)
);

alter table church_staff               enable row level security;
alter table church_staff_period_entries enable row level security;

-- Authenticated Supabase users only (same auth project as MDO admin).
create policy "authenticated read/write" on church_staff
  for all using (auth.role() = 'authenticated');

create policy "authenticated read/write" on church_staff_period_entries
  for all using (auth.role() = 'authenticated');
