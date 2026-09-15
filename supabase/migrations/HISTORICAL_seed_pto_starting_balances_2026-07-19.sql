-- One-time import: seeds each active staff member's PTO starting balance
-- from the "Timothy Evangelical Lutheran Church" Time Off report (Sick
-- leave balance column), accurate as of the last payroll submission,
-- 2026-07-19. Requires staff_pto_starting_balance.sql to have been applied
-- first (adds the staff.pto_starting_balance column).
--
-- Only MDO staff present in the `staff` table are included below — the
-- source report covers the whole church/school and most rows aren't
-- daycare staff, so they're intentionally left out.
--
-- Run the SELECT at the bottom afterward and confirm all 23 rows show the
-- expected balance before considering this done — an update that matches
-- zero rows (e.g. a name typo) fails silently.

update staff set pto_starting_balance = 1.72  where name = 'Alyssa Ramsey';
update staff set pto_starting_balance = 15.56 where name = 'Amy Ricketts';
update staff set pto_starting_balance = 10.36 where name = 'Atoya Walker';
update staff set pto_starting_balance = 2.90  where name = 'Ava Posley';
update staff set pto_starting_balance = 2.26  where name = 'Cat Johnson';
update staff set pto_starting_balance = 2.22  where name = 'Chelsea Daily';
update staff set pto_starting_balance = 3.99  where name = 'Denise Davis';
update staff set pto_starting_balance = 26.70 where name = 'Evie Jarchow';
-- "Nunnally, Jacinda A" in the source report = Jacinda Jockel; her balance
-- there was 0 (no accrual policy on file), so this is a no-op included for
-- completeness/documentation rather than a functional change.
update staff set pto_starting_balance = 0.00  where name = 'Jacinda Jockel';
update staff set pto_starting_balance = 0.57  where name = 'Katlyne Aubuchon';
update staff set pto_starting_balance = 23.60 where name = 'Meagan Bolin';
update staff set pto_starting_balance = 1.70  where name = 'Moriah Bolin';
update staff set pto_starting_balance = 3.80  where name = 'Rachel Bolin';
update staff set pto_starting_balance = 6.18  where name = 'Sage Foster';
update staff set pto_starting_balance = 1.04  where name = 'Lily Gregory';
update staff set pto_starting_balance = 20.55 where name = 'Sonya Jackson';
update staff set pto_starting_balance = 10.80 where name = 'Ruth Krownapple';
update staff set pto_starting_balance = 26.19 where name = 'Skylor Murray';
update staff set pto_starting_balance = 12.06 where name = 'Lara Parker';
update staff set pto_starting_balance = 1.12  where name = 'Kiara Powe';
update staff set pto_starting_balance = 5.05  where name = 'Mary Ellen Scheetz';
-- "Posley-Solis, Lily T" in the source report = Lily Posley.
update staff set pto_starting_balance = 1.87  where name = 'Lily Posley';
-- "Ervin, Olivia C" in the source report = Olivia Krumweide (name change).
update staff set pto_starting_balance = 37.83 where name = 'Olivia Krumweide';

-- Global cutoff date: PTO accrual/usage in the app only counts from this
-- date forward (see staff_pto_starting_balance.sql for why).
insert into settings (key, value)
values ('pto_balance_cutoff_date', '"2026-07-19"'::jsonb)
on conflict (key) do update set value = excluded.value;

-- Verify — should return exactly 23 rows, each with the balance set above.
select name, pto_starting_balance
from staff
where name in (
  'Alyssa Ramsey', 'Amy Ricketts', 'Atoya Walker', 'Ava Posley', 'Cat Johnson',
  'Chelsea Daily', 'Denise Davis', 'Evie Jarchow', 'Jacinda Jockel',
  'Katlyne Aubuchon', 'Meagan Bolin', 'Moriah Bolin', 'Rachel Bolin',
  'Sage Foster', 'Lily Gregory', 'Sonya Jackson', 'Ruth Krownapple',
  'Skylor Murray', 'Lara Parker', 'Kiara Powe', 'Mary Ellen Scheetz',
  'Lily Posley', 'Olivia Krumweide'
)
order by name;
