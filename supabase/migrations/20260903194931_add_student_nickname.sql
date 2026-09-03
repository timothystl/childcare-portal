-- ============================================================
-- Add students.nickname, and backfill the handful of children whose
-- nickname was jammed into child_name as a quoted middle word
-- (e.g. `Francesca "Frankie" Payne`) instead of having its own field.
-- ============================================================
-- Measured live before writing this: exactly 3 students carry a quoted
-- nickname (Francesca "Frankie" Payne, Louis "Lou" Berra, Penelope
-- "Penny" Fister), and the same 3 names appear in 17 `registrations`
-- rows (registrations.child_name is its own free-text copy, not a FK —
-- see this file's "roster names are free text in six tables" note).
-- No other table (attendance_records, billing_overrides,
-- cacfp_meal_records, missing_child_alerts) had a quoted name.
-- waitlist_applications has one unrelated `"..."` — an office note on
-- an inquiry ("Jream (\"Dream\"?)"), not an enrolled child's nickname —
-- deliberately left alone.
--
-- This is also what was silently defeating the ProCare import's name
-- matching for Penelope "Penny" Fister (documented in this file's
-- ProCare section): stripping the quoted form out of child_name is a
-- real bug fix, not just cosmetic.
-- ============================================================

ALTER TABLE students ADD COLUMN IF NOT EXISTS nickname text;

-- students: pull the quoted nickname into its own column, and collapse
-- the quoted-and-surrounding-whitespace span out of child_name in one
-- pass so a double space can't remain in its place.
UPDATE students
SET nickname   = (regexp_match(child_name, '"([^"]+)"'))[1],
    child_name = trim(regexp_replace(child_name, '\s*"[^"]+"\s*', ' ', 'g'))
WHERE child_name ~ '"';

-- registrations carries its own copy of the same name (no FK) — apply
-- the identical cleanup so the two never disagree on spelling.
UPDATE registrations
SET child_name = trim(regexp_replace(child_name, '\s*"[^"]+"\s*', ' ', 'g'))
WHERE child_name ~ '"';
