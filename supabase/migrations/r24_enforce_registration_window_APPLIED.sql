-- ============================================================
-- R24 — enforce the registration window server-side
-- ============================================================
-- APPLIED AND VERIFIED IN PRODUCTION 2026-08-11.
-- Supersedes enforce_registration_window.sql, which was committed but NEVER
-- applied — so the window has only ever been enforced by client-side
-- JavaScript, and the P0001 handler in app.js could never fire.
--
-- ⚠️ BUG FOUND IN THE COMMITTED VERSION. It called jsonb_typeof(value) on
-- settings.value, which is a TEXT column. That would have raised on every
-- INSERT, breaking all registration. The live value is the bare word `open`,
-- which is not even valid JSON. Same T3 trap CLAUDE.md records for the invoice
-- note: settings.value is text, and arrives as text even when it holds JSON.
--
-- This version parses defensively — bare word, JSON string, or {"value": …} —
-- and falls through to the date rule rather than throwing if it cannot parse.
--
-- Admin sessions bypass, so the office can register a family any time.
--
-- Verified post-apply:
--   * admin (authenticated) INSERT succeeds while the window is shut
--   * override 'closed'  -> anon INSERT raises P0001
--   * override 'auto'    -> anon INSERT allowed on day 11 (inside 1st-15th)
--   * override 'open'    -> anon INSERT allowed (the live setting)
--   Both override tests ran inside a transaction that was deliberately rolled
--   back, so the production setting was never actually changed.
--
-- ROLLBACK: DROP TRIGGER enforce_registration_window ON public.registrations;
-- ============================================================

CREATE OR REPLACE FUNCTION public.check_registration_window()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_raw      text;
    v_override text;
    v_now      timestamp;
    v_day      int;
    v_hour     int;
BEGIN
    IF auth.role() = 'authenticated' THEN
        RETURN NEW;
    END IF;

    SELECT value INTO v_raw FROM settings WHERE key = 'reg_window_override';

    IF v_raw IS NOT NULL THEN
        BEGIN
            CASE jsonb_typeof(v_raw::jsonb)
                WHEN 'string' THEN v_override := (v_raw::jsonb) #>> '{}';
                WHEN 'object' THEN v_override := (v_raw::jsonb) ->> 'value';
                ELSE v_override := v_raw;
            END CASE;
        EXCEPTION WHEN OTHERS THEN
            v_override := v_raw;
        END;
    END IF;
    v_override := lower(trim(both '"' from COALESCE(v_override, '')));

    IF v_override = 'open' THEN RETURN NEW; END IF;

    IF v_override = 'closed' THEN
        RAISE EXCEPTION 'Registration window is currently closed.'
            USING ERRCODE = 'P0001',
                  HINT    = 'Contact the office if you believe this is an error.';
    END IF;

    v_now  := NOW() AT TIME ZONE 'America/Chicago';
    v_day  := EXTRACT(DAY  FROM v_now)::int;
    v_hour := EXTRACT(HOUR FROM v_now)::int;

    IF v_day > 15 THEN
        RAISE EXCEPTION 'Registration window is closed. Registrations are accepted from 9 AM Central on the 1st through 11:59 PM Central on the 15th of each month.'
            USING ERRCODE = 'P0001',
                  HINT    = 'Registration opens again at 9 AM Central on the 1st of next month.';
    END IF;

    IF v_day = 1 AND v_hour < 9 THEN
        RAISE EXCEPTION 'Registration window is not yet open. Registration opens at 9 AM Central time on the 1st of each month.'
            USING ERRCODE = 'P0001',
                  HINT    = 'Please check back at 9 AM Central time.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_registration_window ON public.registrations;
CREATE TRIGGER enforce_registration_window
    BEFORE INSERT ON public.registrations
    FOR EACH ROW EXECUTE FUNCTION public.check_registration_window();
