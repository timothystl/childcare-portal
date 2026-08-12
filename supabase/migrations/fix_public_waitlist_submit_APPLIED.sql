-- APPLIED TO PRODUCTION 2026-08-12.
-- ============================================================
-- Fix the public waitlist form
-- ============================================================
-- CLAUDE.md carried this as "needs a human / can't be settled from code":
-- submitWaitlistApplication() chains .insert().select().single(), anon has no
-- SELECT policy, and the last application on file is 2026-07-11. It is now
-- settled from the database, and the answer is that the form is BROKEN.
--
-- Proven as the anon role in a rolled-back transaction:
--   INSERT ... RETURNING id   -> ERROR 42501, "new row violates row-level
--                                security policy for waitlist_applications"
--   INSERT ... (no RETURNING) -> succeeds
--
-- Postgres applies SELECT policies to rows returned by RETURNING, and PostgREST
-- turns .select() into RETURNING. So the whole statement aborts and NOTHING is
-- written — a parent fills in the form, gets an error, and no application is
-- saved. That matches the month-long gap in applications exactly.
--
-- The fix is NOT an anon SELECT policy — that would expose all 37 columns of
-- every family's waitlist entry, which is the R27 class of mistake.
--
-- Injection-tested after applying: a payload carrying status:'offered',
-- paperwork_received:true, deposit_paid:true and applied_at:'2020-01-01'
-- stored pending / false / false / now().

CREATE OR REPLACE FUNCTION public.submit_waitlist_application(p_payload jsonb)
RETURNS TABLE (id bigint, applied_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id bigint;
    v_at timestamptz;
BEGIN
    -- Explicit column allow-list. The caller is the public internet, so the
    -- admin-controlled fields (status, offer_*, tour_*, paperwork, deposit,
    -- archive_*, reminder_*) are simply not reachable — a submitter cannot
    -- promote themselves to 'offered' or backdate applied_at to jump the queue.
    INSERT INTO waitlist_applications (
        parent_name, parent_email, parent_phone,
        child_name, child_dob, expected_due_date,
        desired_start_date, start_flexibility,
        days_of_week, day_type, days_flexible, days_flexible_count,
        has_sibling, sibling_child_name, sibling_room_id,
        notes
    )
    VALUES (
        nullif(trim(p_payload ->> 'parent_name'), ''),
        lower(nullif(trim(p_payload ->> 'parent_email'), '')),
        nullif(trim(p_payload ->> 'parent_phone'), ''),
        nullif(trim(p_payload ->> 'child_name'), ''),
        (p_payload ->> 'child_dob')::date,
        (p_payload ->> 'expected_due_date')::date,
        (p_payload ->> 'desired_start_date')::date,
        coalesce(nullif(p_payload ->> 'start_flexibility', ''), 'flexible'),
        nullif(p_payload ->> 'days_of_week', ''),
        coalesce(nullif(p_payload ->> 'day_type', ''), 'full'),
        coalesce((p_payload ->> 'days_flexible')::boolean, false),
        (p_payload ->> 'days_flexible_count')::smallint,
        coalesce((p_payload ->> 'has_sibling')::boolean, false),
        nullif(trim(p_payload ->> 'sibling_child_name'), ''),
        nullif(p_payload ->> 'sibling_room_id', ''),
        nullif(trim(p_payload ->> 'notes'), '')
    )
    RETURNING waitlist_applications.id, waitlist_applications.applied_at
    INTO v_id, v_at;

    RETURN QUERY SELECT v_id, v_at;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.submit_waitlist_application(jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.submit_waitlist_application(jsonb) TO anon, authenticated;
