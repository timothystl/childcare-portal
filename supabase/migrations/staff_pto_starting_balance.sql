-- Per-staff PTO starting balance, used to seed the PTO Balance shown in the
-- Payroll report from an external system's current balance (e.g. a payroll
-- provider's Time Off report) instead of starting everyone at zero.
-- Paired with the global `pto_balance_cutoff_date` setting: once set, PTO
-- accrual/usage in this app is only counted from that date forward, so the
-- imported starting balance and this app's own tracking don't double-count
-- the same hours.
alter table staff
  add column if not exists pto_starting_balance numeric(8,2) not null default 0;
