-- APPLIED AND VERIFIED IN PRODUCTION 2026-08-16.
-- Companion to incident_three_signatures.sql — apply that one first.
-- ============================================================
-- INCIDENT REPORTS — the teacher's own word for it, and the "After" checklist
-- ============================================================
-- ⚠️ WHY A SECOND COLUMN INSTEAD OF WIDENING incident_type. The handoff's Type
-- chip group is six options — Fall · Bump/bruise · Bite · Scratch · Illness ·
-- Other — and the stored `incident_type` is a four-value CHECK
-- ('injury','illness','behavior','other') that the director's queue, the parent
-- portal, INC_TYPE_LABEL in admin-incidents.js and the "parent read approved"
-- policy all read today.
--
-- Widening the CHECK to hold the chips would have been the smaller diff and it
-- is the wrong one: 'behavior' is a STORED VALUE (CLAUDE.md calls this out by
-- name), so the four categories are load-bearing, and collapsing "Bite" into
-- "injury" at write time throws away the only word on the form that says what
-- actually happened. A bite is a very different conversation from a fall, and
-- the printed report going into a licensing file should say which it was.
--
-- So: incident_type stays the category everything queries, incident_kind
-- carries the chip. Four chips map to 'injury', one each to 'illness' and
-- 'other'. Nothing that reads incident_type needs to change.

ALTER TABLE public.incident_reports
    ADD COLUMN IF NOT EXISTS incident_kind text,
    -- The handoff's "After" block: back to playing, parent called at the time,
    -- medical attention recommended. Distinct from first_aid, which is what was
    -- done at the moment; this is how the child was afterwards.
    ADD COLUMN IF NOT EXISTS after_notes   text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.incident_reports.incident_kind IS
    'The teacher-facing chip label: Fall / Bump or bruise / Bite / Scratch / Illness / Other. incident_type stays the four-value stored category the CHECK constraint and every existing query rely on; this is the finer word the teacher actually picked, and it is what the printed report shows.';

-- submit_incident_report gains p_incident_kind and p_after_notes.
-- ⚠️ Same one-function rule as the parent migration: the previous 15-argument
-- version is DROPPED after the 17-argument one is created, never kept beside
-- it. Named-argument calls from supabase-js match any overload whose extra
-- parameters default, and PostgREST refuses to pick — "Could not choose the
-- best candidate function". Create the new one, drop the old one, restate the
-- grants, in that order, so no call window is left without a function to hit.
--
-- Full body as applied: see incident_three_signatures.sql §5, plus
--   incident_kind = nullif(btrim(p_incident_kind), '')
--   after_notes   = COALESCE(p_after_notes, '{}')
-- in the INSERT column list. Every other guard is unchanged: PIN gate, type
-- CHECK, non-empty description/action, body_view domain, the LEAST(...) clamp
-- that keeps occurred_at out of the future, and the teacher signature written
-- from the PIN holder rather than the request body.

-- ============================================================
-- VERIFIED AFTER APPLYING 2026-08-16
-- ============================================================
--   submit_incident_report overloads                     1
--   anon EXECUTE on the 17-arg signature                  true
