-- APPLIED AND VERIFIED IN PRODUCTION 2026-08-19.
--
-- Staff clock-in was down with:
--     25006: cannot execute INSERT in a read-only transaction
--
-- PostgREST runs a STABLE/IMMUTABLE function in a READ-ONLY transaction. These
-- three were declared STABLE because their own bodies only read — which is true
-- of the body and false of the PIN gate they call:
--
--   staff_clock_status -> staff_id_for_pin -> verify_staff_pin
--                      -> record_pin_attempt  => INSERT INTO pin_attempt_log
--                      -> UPDATE staff        (the lockout counter)
--
-- throttle_staff_pin_attempts_APPLIED.sql (2026-08-12) made verify_staff_pin
-- WRITE on every call — success and failure alike. From that moment any STABLE
-- caller of the PIN gate raised 25006 on every single call.
--
-- VOLATILE is the honest declaration, not a workaround. Authenticating by
-- recording the attempt IS a side effect; marking these STABLE was the bug.
--
-- What this restored:
--   staff_clock_status   (created 2026-08-19) — the kiosk PIN screen. Broke the
--                        day it shipped; 0 clock events had been recorded that
--                        day against 13 the day before.
--   staff_my_schedule    (created 2026-08-16) — staff "My schedule". Born broken.
--   active_missing_child (created 2026-08-16) — the missing-child in-app banner,
--                        polled every 15s. Born broken, and never once returned
--                        a result. No alert had ever been raised, so nothing
--                        made the failure visible.
--
-- Rollback would be ALTER FUNCTION ... STABLE, which reinstates the outage.

ALTER FUNCTION public.staff_clock_status(p_staff_id uuid, p_pin integer, p_work_date date) VOLATILE;
ALTER FUNCTION public.staff_my_schedule(p_staff_id uuid, p_pin integer, p_from date, p_to date) VOLATILE;
ALTER FUNCTION public.active_missing_child(p_staff_id uuid, p_pin integer) VOLATILE;
