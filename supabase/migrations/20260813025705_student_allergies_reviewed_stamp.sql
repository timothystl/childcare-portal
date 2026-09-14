-- Distinguish "the office checked, this child has no allergies" from
-- "nobody has entered anything yet". Today those are the SAME value: all 150
-- children have allergies = '[]', and none is NULL.
--
-- Why this matters more than the wording: the staff quick-log sheet renders a
-- safety panel above every input, and with an empty list it says "No allergies
-- or care notes on file." That is an affirmative all-clear. It is currently
-- shown for every child in the centre, none of whom has been reviewed. A
-- teacher reaching for the snack chip reads it as "checked, she's fine."
--
-- Fixing only the wording would trade one wrong message for another: once the
-- office HAS entered allergies, a child who genuinely has none would keep
-- getting a warning, and a warning shown on every child is a warning nobody
-- reads. The panel needs to know which of the two is true, so the data has to
-- record it.

alter table public.students
  add column if not exists allergies_reviewed_at timestamptz;

comment on column public.students.allergies_reviewed_at is
  'Set when the office saves this child''s allergy/care-note field. NULL means '
  'never reviewed — the staff safety panel says so rather than implying an '
  'all-clear. An empty allergies array WITH this set means a real "none".';

-- Deliberately NOT backfilled. Stamping now would mark all 150 children as
-- reviewed when not one of them has been, which is precisely the false
-- all-clear this exists to prevent.

-- anon must not read it (same posture as the rest of students' safety data;
-- the staff app reaches children through the PIN-gated definer RPC).
revoke select (allergies_reviewed_at) on public.students from anon;
