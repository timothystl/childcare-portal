-- ROLLBACK — r26_complete_revoke_anon_staff_wages.sql
--
-- ⚠️ THINK HARD BEFORE RUNNING THIS. It re-exposes staff wages and payroll
-- hours to the public anon key. No application code needs these grants; the
-- only thing that ever used them was payroll.html running with an expired
-- session, which is a bug rather than a feature.
--
-- If payroll.html is broken after the revoke, the correct fix is in the page
-- (re-check the session and bounce to login), not here.

GRANT SELECT (hourly_rate, salary_biweekly, email, hire_date, pay_type, created_at)
    ON public.staff TO anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_hours TO anon;
