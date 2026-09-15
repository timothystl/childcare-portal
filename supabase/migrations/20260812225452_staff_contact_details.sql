-- APPLIED TO PRODUCTION 2026-08-12.
--
-- Staff contact details — groundwork for real Supabase Auth accounts.
--
-- ── WHY ─────────────────────────────────────────────────────
-- Staff run the log app on their OWN phones, not a shared room device. That
-- inverts the original reasoning: a persistent session beats a 4-digit PIN
-- re-typed into every single request, and a personal device is where a real
-- credential belongs.
--
-- Supabase Auth needs an email (or a phone plus an SMS provider). Only 10 of
-- 31 active staff had an email on file and there was no phone column at all,
-- so the migration is gated on data that does not exist yet. This adds the
-- column and the uniqueness the auth mapping will depend on, so the office can
-- collect it first.
--
-- ⚠️ CORRECTION (same day, before any of this was built on). An earlier version
-- of this comment said "the clock-in kiosk stays PIN-based, clockin.html IS a
-- shared wall device, so two auth paths is the correct end state." That is
-- WRONG. There is no kiosk. Staff clock in on their own phones too — the name
-- `clockin.html` and the word "kiosk" throughout this repo are historical and
-- actively mislead.
--
-- The consequence is the opposite of what that note claimed: with no shared
-- device anywhere, the PIN has no remaining justification and retires
-- COMPLETELY once staff have accounts, rather than narrowing to clock-in.
-- Do not plan around the old note.
--
-- ── WHAT ────────────────────────────────────────────────────
alter table public.staff add column if not exists phone text;

comment on column public.staff.phone is
  'Mobile number. Collected alongside email ahead of the staff auth migration.';

-- Email becomes the auth identity, so two staff sharing one address would map
-- two people onto a single account. Catch it at data entry, not at cutover.
-- Partial: blank/NULL stays allowed until the addresses are collected.
create unique index if not exists staff_email_unique
  on public.staff (lower(email))
  where email is not null and email <> '';

-- ── A LATENT GRANT, CLOSED ──────────────────────────────────
-- anon held INSERT/UPDATE/REFERENCES on EVERY column of staff, including
-- staff_pin_hash, hourly_rate and salary_biweekly. Unbacked today — RLS has no
-- anon write policy, verified as the role: UPDATE hit 0 rows, INSERT raised
-- 42501. But an unbacked grant is a loaded gun. Add one permissive anon policy
-- for any reason and it silently becomes a staff-PIN-and-wage rewrite from the
-- public key.
--
-- Same class as revoke_unbacked_anon_grants (which swept 19 tables); `staff`
-- was missed there because R26 had already narrowed its SELECT and it looked
-- done.
--
-- Note the failure mode this had: RLS turns a forbidden UPDATE into 0 rows
-- affected, NOT an error. A probe that only checks for an exception reads a
-- blocked write as a successful no-op. Count the rows.
revoke insert, update, references on public.staff from anon;

-- phone is deliberately NOT granted to anon. Column-level grants do not extend
-- to new columns, so anon's SELECT stays the display set on its own, but say it
-- out loud rather than relying on that.
revoke select (phone) on public.staff from anon;

-- ── VERIFIED AFTER APPLYING, as anon, rolled back ───────────
--   anon SELECT phone          -> refused 42501
--   anon UPDATE staff          -> refused 42501  (was: silently 0 rows)
--   anon SELECT name/role/room -> ok — the kiosk name-picker sign-in screen
--                                 depends on these and still reads
