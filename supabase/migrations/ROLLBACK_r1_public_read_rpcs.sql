-- ROLLBACK — R1
--
-- ⚠️ Re-exposes every child name, parent name, parent email and care schedule
-- in the center to the public anon key. Only do this if the public
-- registration flow or the parent lookup page is broken AND the RPCs are
-- proven to be the cause.
--
-- Prefer fixing the RPC. The frontend from v2.5.16 onward does not read these
-- tables directly, so restoring the policies alone will not "fix" anything —
-- it only widens access again.

CREATE POLICY "anon select registrations"      ON public.registrations      FOR SELECT TO anon USING (true);
CREATE POLICY "anon select registration_dates" ON public.registration_dates FOR SELECT TO anon USING (true);
GRANT SELECT ON public.registrations      TO anon;
GRANT SELECT ON public.registration_dates TO anon;
