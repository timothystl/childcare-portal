-- Migration: enforce_registration_window.sql
-- Adds a BEFORE INSERT trigger on the registrations table that enforces the
-- registration window server-side, respecting the admin-configurable
-- reg_window_override setting stored in the settings table.
--
-- Window: 9 AM Central (America/Chicago, DST-aware) on the 1st of the month
-- through 11:59 PM Central on the 15th of the month.
--
-- Without this, a technically-savvy parent could bypass the client-side check
-- by calling the Supabase REST API directly or using DevTools to re-enable the
-- disabled submit button.
--
-- Authenticated (admin) sessions bypass the check so admins can create/edit
-- registrations at any time.

-- -----------------------------------------------------------------------
-- Trigger function
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_registration_window()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_override text;
    v_now      timestamp;   -- current time in America/Chicago (DST-aware)
    v_day      int;
    v_hour     int;
BEGIN
    -- Admins are authenticated Supabase users — they bypass the window check.
    IF auth.role() = 'authenticated' THEN
        RETURN NEW;
    END IF;

    -- Read the admin-configurable override from the settings table.
    -- Value is stored as a JSON string, e.g. {"value": "open"} or "open" directly.
    -- fetchSetting() in the frontend stores scalar values as JSON strings.
    SELECT
        CASE
            WHEN jsonb_typeof(value) = 'string' THEN value #>> '{}'
            ELSE value ->> 'value'
        END
    INTO v_override
    FROM settings
    WHERE key = 'reg_window_override';

    -- 'open' override: always allow parent registrations
    IF v_override = 'open' THEN
        RETURN NEW;
    END IF;

    -- 'closed' override: always block parent registrations
    IF v_override = 'closed' THEN
        RAISE EXCEPTION 'Registration window is currently closed.'
            USING ERRCODE = 'P0001',
                  HINT    = 'Contact the office if you believe this is an error.';
    END IF;

    -- Default (no override or 'auto'): allow only from 9 AM Central on the 1st
    -- through 11:59 PM Central on the 15th of the month.
    -- America/Chicago handles CST (UTC-6) and CDT (UTC-5) automatically.
    v_now  := NOW() AT TIME ZONE 'America/Chicago';
    v_day  := EXTRACT(DAY  FROM v_now)::int;
    v_hour := EXTRACT(HOUR FROM v_now)::int;

    IF v_day > 15 THEN
        RAISE EXCEPTION 'Registration window is closed. Registrations are accepted from 9 AM Central on the 1st through 11:59 PM Central on the 15th of each month (today is the %).',
            CASE v_day
                WHEN 11 THEN '11th'
                WHEN 12 THEN '12th'
                WHEN 13 THEN '13th'
                ELSE v_day || CASE
                    WHEN v_day % 10 = 1 THEN 'st'
                    WHEN v_day % 10 = 2 THEN 'nd'
                    WHEN v_day % 10 = 3 THEN 'rd'
                    ELSE 'th'
                END
            END
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

-- -----------------------------------------------------------------------
-- Attach trigger to registrations table
-- -----------------------------------------------------------------------
DROP TRIGGER IF EXISTS enforce_registration_window ON registrations;

CREATE TRIGGER enforce_registration_window
    BEFORE INSERT ON registrations
    FOR EACH ROW
    EXECUTE FUNCTION check_registration_window();
