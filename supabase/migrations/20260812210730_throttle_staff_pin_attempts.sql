-- APPLIED TO PRODUCTION 2026-08-12. Two migrations recorded together:
--   throttle_staff_pin_attempts
--   fix_lookup_staff_by_pin_found_reset   (see the FOUND bug at the bottom)
--
-- ============================================================
-- Staff PIN brute-force throttle
-- ============================================================
-- THE PROBLEM. lookup_staff_by_pin is anon-callable by design — the clock-in
-- kiosk has no account and the public key is in the page source. Staff PINs are
-- 4 digits, so the space is 10,000, and the function tries the guess against
-- EVERY staff row: with ~33 staff, roughly 1 in 300 random guesses lands on
-- somebody. There was no attempt limit of any kind, and a staff PIN now unlocks
-- child logging, photo upload and incident filing — not just a time clock.
--
-- WHY NOT JUST REVOKE IT: the kiosk genuinely needs it.
--
-- SHAPE OF THE FIX. A purely global limiter would let an attacker take the
-- kiosk offline for the whole centre by burning the budget — availability
-- traded away on a device staff need at 8am. So the limit is PER CALLER where
-- the caller can be identified, with a global backstop for distributed
-- attempts.
--
--   per IP : 10 failures in 15 minutes   (a fat-fingered PIN never reaches it)
--   global : 300 failures in 5 minutes   (33 staff mistyping all day cannot)
--
-- Only FAILURES count, so a staff member typing their own PIN correctly is
-- unaffected unless their own device just failed ten times.
--
-- ⚠️ HEADER AVAILABILITY IS NOT ASSUMED. PostgREST exposes request.headers, but
-- if that stops arriving the per-IP branch silently becomes a no-op — which is
-- exactly why the global backstop exists rather than failing open quietly.
-- CHECK THIS: if client_ip is NULL for every row in pin_attempt_log, the header
-- is not arriving and the per-IP limit is doing nothing.
--     select count(*) filter (where client_ip is not null) as with_ip,
--            count(*) as total from pin_attempt_log;
--
-- The block returns the same NULL a wrong PIN returns, so an attacker cannot
-- tell throttling from a bad guess.

CREATE TABLE IF NOT EXISTS public.pin_attempt_log (
    id           bigserial PRIMARY KEY,
    attempted_at timestamptz NOT NULL DEFAULT now(),
    client_ip    text,
    succeeded    boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS pin_attempt_log_time_idx ON public.pin_attempt_log (attempted_at DESC);
CREATE INDEX IF NOT EXISTS pin_attempt_log_ip_idx
    ON public.pin_attempt_log (client_ip, attempted_at DESC) WHERE client_ip IS NOT NULL;

ALTER TABLE public.pin_attempt_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pin_attempt_log FROM anon, authenticated;
GRANT SELECT ON public.pin_attempt_log TO authenticated;
CREATE POLICY "admin read" ON public.pin_attempt_log
    FOR SELECT TO authenticated USING (is_admin());
-- Written only by the definer functions; nobody can insert or delete directly,
-- so an attacker cannot erase their own trail.

-- pin_client_ip()        cf-connecting-ip, else first hop of x-forwarded-for.
--                        NULL off PostgREST (cron, SQL editor, service role) —
--                        those are trusted paths and are not throttled.
--                        x-forwarded-for is spoofable, which is why it is only
--                        ever used to make the limit TIGHTER, never to bypass.
-- pin_attempts_blocked() true = refuse WITHOUT checking the PIN. Refusing
--                        before the bcrypt loop is the point: cheap for us,
--                        useless for them.
-- record_pin_attempt()   logs, and prunes >24h rows on ~1% of calls rather than
--                        adding another cron job to forget about.
-- (Full bodies in git history.)

-- Both entry points throttle, or the limit is decorative: staff_id_for_pin
-- backs photo upload, incident filing and every quick-log write;
-- lookup_staff_by_pin backs the kiosk.

-- ============================================================
-- ⚠️ THE BUG THIS SHIPPED WITH, AND WHY IT MATTERED
-- ============================================================
-- First version of lookup_staff_by_pin read:
--     SELECT ... INTO v_staff ...;
--     PERFORM record_pin_attempt(v_ip, FOUND);
--     IF NOT FOUND THEN RETURN NULL; END IF;
--
-- In plpgsql, FOUND is reset by EVERY statement that can set it — including
-- PERFORM. So `IF NOT FOUND` described the PERFORM (always succeeds), not the
-- SELECT. A wrong PIN fell through and returned jsonb_build_object over an
-- empty record: {"id": null, "name": null, ...} instead of NULL.
--
-- clockin.html does `if (!data) -> invalid PIN`, and a non-null object is
-- truthy — so ANY wrong PIN would have been accepted as a sign-in, with a null
-- staff id, on the exact screen this migration exists to protect.
--
-- Fixed by capturing FOUND into v_hit immediately. staff_id_for_pin was already
-- correct because it tests `v_id IS NOT NULL` rather than trusting FOUND to
-- survive a call.
--
-- ============================================================
-- VERIFIED AFTER APPLYING (rolled back)
-- ============================================================
--   correct PIN            -> staff object with an id
--   wrong PIN              -> NULL (both functions)
--   10 failures from an IP -> that IP blocked, a different IP unaffected
--   300 failures globally  -> blocked even with the CORRECT pin
