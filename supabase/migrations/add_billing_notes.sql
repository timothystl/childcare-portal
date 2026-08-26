-- ============================================================
-- BILLING NOTES
-- ============================================================
-- A free-text note per family/month on the billing report, separate from
-- the "Adjustments" column's automated exception text (days changed, new
-- this month, fees due, credit on account). Those causes tell the director
-- what the ENGINE noticed changed since last month; this is a place for
-- what SHE knows — "confirmed with mom, this is correct," "will pay by
-- check," "sibling starts next week" — that has nothing to do with a
-- month-over-month diff.
-- ============================================================

-- Unique on the plain (month, parent_email) columns, not a lower()
-- expression — matching billing_overrides exactly, because a supabase-js
-- `.upsert(..., {onConflict: 'month,parent_email'})` needs a real unique
-- constraint on those literal columns to target; an expression index does
-- not satisfy ON CONFLICT for a plain column list.
CREATE TABLE IF NOT EXISTS public.billing_notes (
    id           bigserial PRIMARY KEY,
    month        char(7) NOT NULL,
    parent_email text NOT NULL,
    note         text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    updated_by   text,
    UNIQUE (month, parent_email)
);

ALTER TABLE public.billing_notes ENABLE ROW LEVEL SECURITY;

-- Same posture as billing_overrides: no anon grant at all, explicit
-- revoke rather than relying on RLS alone (RLS never applies to
-- TRUNCATE — see the CLAUDE.md TRUNCATE finding this app already fixed
-- once on eight other tables).
REVOKE ALL ON public.billing_notes FROM anon, PUBLIC;

DROP POLICY IF EXISTS "admin full only" ON public.billing_notes;
CREATE POLICY "admin full only" ON public.billing_notes
    FOR ALL TO authenticated
    USING (admin_role() = 'full')
    WITH CHECK (admin_role() = 'full');

-- Supabase's default privileges grant ALL (including TRUNCATE) on a new
-- public table directly to `authenticated` at creation, invisible above —
-- exactly the NEW-1 class this repo already found and fixed once on
-- admin_push_subscriptions. RLS never applies to TRUNCATE, so it has to be
-- stripped explicitly rather than left to the "admin full only" policy.
REVOKE ALL ON public.billing_notes FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_notes TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.billing_notes_id_seq TO authenticated;
