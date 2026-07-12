-- ============================================================
-- FS1 — duplicate-prevention unique index (RUN AFTER DEDUP)
-- ============================================================
-- DO NOT run this until the existing duplicate confirmed
-- (lower(child_name), month_key) rows in prod have been reconciled — the
-- CREATE UNIQUE INDEX below will fail while any collision remains.
--
-- Find the remaining collisions with:
--
--   SELECT lower(child_name) AS child, month_key, count(*), array_agg(id)
--   FROM registrations
--   WHERE status = 'confirmed' AND month_key IS NOT NULL
--   GROUP BY 1, 2
--   HAVING count(*) > 1
--   ORDER BY 3 DESC;
--
-- For each group decide whether the extra rows are true duplicates (merge
-- their registration_dates into the surviving row, then delete the extras)
-- or legitimately distinct, before creating the index.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS registrations_child_month_unique
ON registrations (lower(child_name), month_key)
WHERE status = 'confirmed';
