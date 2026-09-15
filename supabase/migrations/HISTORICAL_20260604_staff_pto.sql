-- PTO hours tracking for MDO staff, per pay period.
-- Apply in Supabase SQL Editor.

create table if not exists staff_pto_entries (
  id               uuid primary key default gen_random_uuid(),
  staff_id         uuid not null references staff(id) on delete cascade,
  period_start     date not null,
  pto_hours_used   numeric(6,2) not null default 0,
  pto_hours_earned numeric(6,2) not null default 0,
  unique(staff_id, period_start)
);

alter table staff_pto_entries enable row level security;

create policy "authenticated read/write" on staff_pto_entries
  for all using (auth.role() = 'authenticated');
