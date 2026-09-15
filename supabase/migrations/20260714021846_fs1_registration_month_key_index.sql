-- ============================================================
-- FS1 — duplicate-prevention unique index
-- ============================================================
-- APPLIED to prod 2026-07-14 after manually reconciling all 38 pre-existing
-- duplicate confirmed (lower(child_name), month_key) groups with the owner.
-- Full account of what was merged/deleted/split, including the three
-- judgment-call cases (Patrick Baker, Josephine/Scarlett Ricketts, Willow
-- French), is in docs/NEXT_STEPS.md under "Incident log — 2026-07-14".
--
-- Kept here (idempotent, CREATE ... IF NOT EXISTS) as the durable migration
-- record. If this ever needs re-running after new duplicates appear, find
-- them first with:
--
--   SELECT lower(child_name) AS child, month_key, count(*), array_agg(id)
--   FROM registrations
--   WHERE status = 'confirmed' AND month_key IS NOT NULL
--   GROUP BY 1, 2
--   HAVING count(*) > 1
--   ORDER BY 3 DESC;
--
-- and reconcile each group (merge disjoint registration_dates into a
-- surviving row, or split cross-month rows) before this can succeed.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS registrations_child_month_unique
ON registrations (lower(child_name), month_key)
WHERE status = 'confirmed';
