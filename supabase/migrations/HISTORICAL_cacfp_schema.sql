-- CACFP (Child and Adult Care Food Program) tracking.
-- Five tables: income applications, meal point-of-service records, menus,
-- reimbursement rates (versioned by effective_date so a claim always uses
-- the rate that was in force that month), and the claim itself (generated
-- summary, snapshotted so later edits/rate updates don't change history).
--
-- Retention: CACFP requires records be retrievable for 3+ years. Nothing
-- here has an expiry/purge — do not add one later without checking that
-- requirement first.
--
-- Not auto-applied — run by hand in the Supabase SQL Editor (see CLAUDE.md).

-- ============================================================
-- Income eligibility applications
-- ============================================================
-- One row per submission, never updated in place. A family's current tier
-- is the row with the latest effective_date <= today. Renewals / income
-- changes just insert a new row, so history is preserved automatically.
create table if not exists cacfp_income_applications (
  id             uuid        primary key default gen_random_uuid(),
  family_id      uuid        not null references families(id) on delete cascade,
  household_size integer     not null,
  annual_income  numeric     not null,
  tier           text        not null check (tier in ('free','reduced','paid')),
  effective_date date        not null,
  submitted_by   text        not null default '',
  notes          text        not null default '',
  created_at     timestamptz not null default now()
);

create index if not exists cacfp_income_applications_family_idx
  on cacfp_income_applications(family_id, effective_date desc);

-- ============================================================
-- Meal / snack point-of-service records
-- ============================================================
-- One row per child per date per meal type. Keyed off registrations (the
-- actual care-day roster), not students, because the daily roster the
-- meal-count screen pulls from (getRosterForDate) is built from
-- registrations/registration_dates, which use free-text child_name rather
-- than a students.id link. family_id is best-effort, resolved by matching
-- parent_email against families at entry time (same email-matching
-- convention already used by billing_overrides) so claim generation can
-- look up the child's income tier; it's left null if no match is found,
-- which the claim report treats the same as "no application on file" (paid).
create table if not exists cacfp_meal_records (
  id              uuid        primary key default gen_random_uuid(),
  registration_id bigint      not null references registrations(id) on delete cascade,
  family_id       uuid        references families(id) on delete set null,
  child_name      text        not null,
  room_id         text        not null,
  care_date       date        not null,
  meal_type       text        not null check (meal_type in ('breakfast','am_snack','lunch','pm_snack')),
  status          text        not null check (status in ('served','brought_own','absent')),
  recorded_by     text        not null default '',
  recorded_at     timestamptz not null default now(),
  unique (registration_id, care_date, meal_type)
);

create index if not exists cacfp_meal_records_date_idx on cacfp_meal_records(care_date);
create index if not exists cacfp_meal_records_family_idx on cacfp_meal_records(family_id);

-- ============================================================
-- Menus
-- ============================================================
-- One row per date per meal type. status='published' rows are readable by
-- the public menu page; drafts are admin-only.
create table if not exists cacfp_menus (
  id          uuid        primary key default gen_random_uuid(),
  menu_date   date        not null,
  meal_type   text        not null check (meal_type in ('breakfast','am_snack','lunch','pm_snack')),
  food_items  text        not null default '',
  milk        boolean     not null default false,
  meat_alt    boolean     not null default false,
  vegetable   boolean     not null default false,
  fruit       boolean     not null default false,
  grain       boolean     not null default false,
  status      text        not null default 'draft' check (status in ('draft','published')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (menu_date, meal_type)
);

create index if not exists cacfp_menus_date_idx on cacfp_menus(menu_date);

-- ============================================================
-- Reimbursement rates (USDA, published ~annually each July)
-- ============================================================
-- New row per rate change — never overwrite an existing one, so a claim
-- generated for a past month keeps using the rate that was actually in
-- force that month even after a later rate update.
create table if not exists cacfp_reimbursement_rates (
  id             bigint      generated always as identity primary key,
  effective_date date        not null,
  meal_type      text        not null check (meal_type in ('breakfast','am_snack','lunch','pm_snack')),
  tier           text        not null check (tier in ('free','reduced','paid')),
  rate           numeric     not null,
  created_at     timestamptz not null default now(),
  unique (effective_date, meal_type, tier)
);

-- ============================================================
-- Monthly claims — generated summary + locked snapshot
-- ============================================================
-- Mirrors the billing_cycles / billing_invoices pattern already used for
-- monthly billing: a period row that's 'open' (re-generatable) until
-- 'finalized' (locked), with the actual numbers snapshotted into line rows
-- rather than recomputed on read.
create table if not exists cacfp_claim_periods (
  id            bigint      generated always as identity primary key,
  month         date        not null unique, -- first of month
  status        text        not null default 'open' check (status in ('open','finalized')),
  generated_at  timestamptz not null default now(),
  finalized_at  timestamptz,
  finalized_by  text,
  notes         text        not null default ''
);

create table if not exists cacfp_claim_lines (
  id                    bigint  generated always as identity primary key,
  claim_period_id       bigint  not null references cacfp_claim_periods(id) on delete cascade,
  meal_type             text    not null check (meal_type in ('breakfast','am_snack','lunch','pm_snack')),
  tier                  text    not null check (tier in ('free','reduced','paid')),
  meal_count            integer not null default 0,
  rate_applied          numeric not null default 0,
  reimbursement_amount  numeric not null default 0,
  unique (claim_period_id, meal_type, tier)
);

-- ============================================================
-- RLS
-- ============================================================
-- All CACFP tables are admin-entered (no anonymous parent-facing write
-- path, unlike families/students), so — except for the published-menu
-- read below — access is authenticated-only, matching the
-- admin_all_students / "Auth access" policies already used for
-- students/billing_invoices.

alter table cacfp_income_applications enable row level security;
create policy "admin_all_cacfp_income_applications" on cacfp_income_applications
  for all to authenticated using (true) with check (true);

alter table cacfp_meal_records enable row level security;
create policy "admin_all_cacfp_meal_records" on cacfp_meal_records
  for all to authenticated using (true) with check (true);

alter table cacfp_menus enable row level security;
create policy "admin_all_cacfp_menus" on cacfp_menus
  for all to authenticated using (true) with check (true);
create policy "anon_select_published_cacfp_menus" on cacfp_menus
  for select to anon using (status = 'published');

alter table cacfp_reimbursement_rates enable row level security;
create policy "admin_all_cacfp_reimbursement_rates" on cacfp_reimbursement_rates
  for all to authenticated using (true) with check (true);

alter table cacfp_claim_periods enable row level security;
create policy "admin_all_cacfp_claim_periods" on cacfp_claim_periods
  for all to authenticated using (true) with check (true);

alter table cacfp_claim_lines enable row level security;
create policy "admin_all_cacfp_claim_lines" on cacfp_claim_lines
  for all to authenticated using (true) with check (true);
