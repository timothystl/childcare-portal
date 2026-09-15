-- APPLIED TO PRODUCTION 2026-08-12.
-- ============================================================
-- PHASE 1 — incident reports, director-reviewed before parents see them
-- ============================================================
-- ⚠️ THIS REVERSES THE PLAN. PARENT_PORTAL_PLAN §5 said parents are notified
-- immediately with director review after. The director decided the opposite on
-- 2026-08-12, and the reason is sound: an incident is the one case where a
-- staff member's first phrasing reaches a parent unedited, at the worst
-- possible moment. "Fell and hit his head" lands very differently at 2pm from a
-- phone than after Jacinda has seen the child.
--
-- Flow: staff submit -> director reviews -> approval both PUBLISHES the report
-- and notifies the family. A submitted report is invisible to parents; no
-- policy exists that can return one.
--
-- RETENTION: never swept. Guidelines 3 years, statute of limitations 5, major
-- injury until the child is 23. Nothing here expires, deliberately — the daily
-- photo sweeper filters to kind = 'daily' for the same reason.

CREATE TABLE IF NOT EXISTS public.incident_reports (
    id                   bigserial PRIMARY KEY,
    student_id           uuid NOT NULL REFERENCES public.students(id) ON DELETE RESTRICT,
    care_date            date NOT NULL,
    occurred_at          timestamptz NOT NULL DEFAULT now(),
    incident_type        text NOT NULL CHECK (incident_type IN ('injury','illness','behavior','other')),
    location             text,
    body_area            text,
    description          text NOT NULL,
    action_taken         text NOT NULL,
    reported_by_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
    -- Denormalised on purpose: a report is a record. If the staff member leaves
    -- and the row is later removed, it must still say who wrote it.
    reported_by_name     text,
    status               text NOT NULL DEFAULT 'submitted'
                            CHECK (status IN ('submitted','approved','returned')),
    reviewed_by          text,
    reviewed_at          timestamptz,
    director_notes       text,
    parent_notified_at   timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now()
);
-- ON DELETE RESTRICT, not CASCADE: deleting a child must not silently destroy
-- an injury record a family or an insurer may need years later.

CREATE INDEX IF NOT EXISTS incident_reports_student_idx ON public.incident_reports (student_id, care_date DESC);
CREATE INDEX IF NOT EXISTS incident_reports_status_idx  ON public.incident_reports (status, created_at DESC);

ALTER TABLE public.child_photos
    ADD COLUMN IF NOT EXISTS incident_id bigint REFERENCES public.incident_reports(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS child_photos_incident_idx ON public.child_photos (incident_id) WHERE incident_id IS NOT NULL;

ALTER TABLE public.incident_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.incident_reports FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.incident_reports TO authenticated;
-- No DELETE grant for anyone. A report is amended by review, never removed.

CREATE POLICY "admin any role" ON public.incident_reports
    FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- ⚠️ The whole point: 'approved' only.
CREATE POLICY "parent read approved" ON public.incident_reports
    FOR SELECT TO authenticated
    USING (status = 'approved' AND parent_owns_student(student_id));

-- submit_incident_report(): PIN-gated definer, always inserts status
-- 'submitted'; only the director can approve. Full body in git history.
-- review_incident_report(): admin-only, stamps reviewed_by from the JWT so
-- 'approved' can never be set without a reviewer recorded.

-- ============================================================
-- VERIFIED AFTER APPLYING, as the roles themselves (rolled back)
-- ============================================================
--   staff/anon submits            -> returns an id, status 'submitted'
--   parent sees submitted report  -> 0 rows
--   parent calls review(approved) -> false, AND status stays 'submitted'
--   director calls review         -> true
--   parent sees approved report   -> 1 row
--   reviewed_by stamped           -> mdo@timothystl.org
