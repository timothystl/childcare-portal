-- ============================================================
-- Clear staff PIN credential on deactivation
-- ============================================================
-- Confirmed in the 2026-09-08 password/account security review: every
-- inactive staff row still carried a live bcrypt PIN hash indefinitely
-- (14 of 14 inactive rows at review time). verify_staff_pin() already
-- refuses inactive staff — `s.active = true` is part of its lookup — so
-- this was never directly exploitable. But a future code path that reads
-- staff_pin_hash without also checking `active` would silently reopen it,
-- and there is no reason to keep credential material for someone who no
-- longer works here.
--
-- A trigger (rather than a JS-side change) is deliberate: setStaffActive()
-- in js/supabase.js does a plain client-side `UPDATE staff SET active =
-- ...`, so a trigger is the one place guaranteed to run no matter which
-- code path flips the flag, now or later.

CREATE OR REPLACE FUNCTION public.clear_staff_pin_on_deactivate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.active = false AND OLD.active = true THEN
        NEW.staff_pin_hash      := NULL;
        NEW.staff_pin           := NULL;
        NEW.pin_failed_attempts := 0;
        NEW.pin_locked_until    := NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS staff_clear_pin_on_deactivate ON public.staff;
CREATE TRIGGER staff_clear_pin_on_deactivate
    BEFORE UPDATE ON public.staff
    FOR EACH ROW
    EXECUTE FUNCTION public.clear_staff_pin_on_deactivate();

-- Retroactive sweep: apply the same rule to staff already sitting inactive
-- with a live PIN hash at review time, so the fix isn't forward-only.
UPDATE public.staff
SET staff_pin_hash = NULL, staff_pin = NULL, pin_failed_attempts = 0, pin_locked_until = NULL
WHERE active = false AND (staff_pin_hash IS NOT NULL OR staff_pin IS NOT NULL);

-- ============================================================
-- VERIFY AFTER APPLYING
-- ============================================================
--   select count(*) from staff where active = false and staff_pin_hash is not null;
--   -- expect 0
--
--   -- deactivate/restore an active test staff row and confirm the hash clears:
--   update staff set active = false where id = '<test id>';
--   select staff_pin_hash, pin_failed_attempts, pin_locked_until from staff where id = '<test id>';
--   -- expect null, 0, null
