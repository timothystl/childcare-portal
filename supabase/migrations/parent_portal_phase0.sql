-- ============================================================
-- PARENT PORTAL — PHASE 0 (foundation)
-- ============================================================
-- Design: docs/PARENT_PORTAL_PLAN.md §4.
-- Nothing parent-visible ships from this. It is the ground everything else
-- stands on: child safety data, photo consent, and a database identity for
-- parents that is NOT the public anon key.
--
-- Apply by hand in the Supabase SQL Editor — supabase/migrations/ is NOT
-- auto-applied.
--
-- ROLLBACK: ROLLBACK_parent_portal_phase0.sql
-- ============================================================


-- ── 1. Child safety and consent ──────────────────────────────
-- allergies is [{label, severity}] where severity is one of:
--   'severe'      — solid --tang chip, white text. Anaphylaxis-class.
--   'sensitivity' — outlined chip. Intolerance, not life-threatening.
--   'note'        — outlined chip. Care note, not an allergy (e.g. "no dairy
--                   before nap", "inhaler in cubby").
-- The design makes this panel a safety requirement: it renders ABOVE every
-- input on the staff quick-log sheet, so a teacher sees it before logging a
-- meal. Free-text `label` deliberately — real allergies do not fit an enum.
ALTER TABLE public.students
    ADD COLUMN IF NOT EXISTS allergies     jsonb   NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS care_notes    text,
    ADD COLUMN IF NOT EXISTS photo_release boolean NOT NULL DEFAULT true;

-- Guard the shape so a malformed write can't make the staff panel throw and
-- hide an allergy. Array of objects, each with a non-empty label and a known
-- severity.
--
-- The check lives in a function because Postgres rejects subqueries in a CHECK
-- constraint directly (0A000), and validating "every element of an array" needs
-- one. Caveat that comes with that: changing this function does NOT revalidate
-- existing rows — if the allowed severities ever change, re-check by hand.
CREATE OR REPLACE FUNCTION public.allergies_shape_ok(v jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
    SELECT jsonb_typeof(v) = 'array'
       AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(v) e
           WHERE jsonb_typeof(e) <> 'object'
              OR COALESCE(e ->> 'label', '') = ''
              OR COALESCE(e ->> 'severity', '') NOT IN ('severe', 'sensitivity', 'note')
       );
$$;

ALTER TABLE public.students DROP CONSTRAINT IF EXISTS students_allergies_shape;
ALTER TABLE public.students ADD CONSTRAINT students_allergies_shape
    CHECK (public.allergies_shape_ok(allergies));

-- The roster and the quick-log sheet both ask "which children here have
-- allergies", which is a scan for a non-empty array.
CREATE INDEX IF NOT EXISTS students_has_allergies_idx
    ON public.students ((jsonb_array_length(allergies) > 0))
    WHERE jsonb_array_length(allergies) > 0;

-- Default is RELEASED, per the director: the exceptions are a handful of
-- families and she will correct those. Photos containing a child whose flag is
-- false stay internal to staff.
COMMENT ON COLUMN public.students.photo_release IS
    'Parent-toggleable. false = this child''s photos are visible only to staff '
    'and their own parents; any photo containing them is withheld from other '
    'families regardless of those families'' own consent.';


-- ── 2. A database identity for parents ───────────────────────
-- ⚠️ READ THIS BEFORE CHANGING THE ROLE.
--
-- Parents must NOT be given the `authenticated` role. Every existing admin
-- table is policied `FOR ALL TO authenticated USING (true)` — billing_invoices,
-- staff (wages), admin_audit_log, all of them. Handing ~242 parents that role
-- would give each of them full read/write on the center's payroll and ledger.
--
-- `parent_portal` is NOLOGIN and reachable only by the API gateway assuming it
-- from a JWT `role` claim. It starts with NO table privileges at all; each
-- parent-facing table grants explicitly as it is built, and every policy on
-- those tables is written `TO parent_portal`.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'parent_portal') THEN
        CREATE ROLE parent_portal NOLOGIN;
    END IF;
END $$;

GRANT parent_portal TO authenticator;
GRANT USAGE ON SCHEMA public TO parent_portal;

-- Belt and braces: Supabase's default grants are generous, and R26/R27 both
-- happened because a role quietly held privileges nobody had granted on
-- purpose. Start this role at zero.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM parent_portal;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM parent_portal;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM parent_portal;

-- Future tables must opt in explicitly too.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM parent_portal;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM parent_portal;


-- ── 3. Sessions that outlive an hour ─────────────────────────
-- The access JWT stays short (1h). This is the revocable half: one row per
-- device, hashed like a password because a stolen refresh token is a session.
-- Sign-out revokes the row; the existing PIN lockout rules are untouched.
CREATE TABLE IF NOT EXISTS public.parent_refresh_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
    -- Which parent on the family record signed in, so the portal can tell them
    -- apart later (messages, read receipts) even though push is per-family.
    parent_slot smallint NOT NULL DEFAULT 1 CHECK (parent_slot IN (1, 2)),
    token_hash  text NOT NULL,
    device_label text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    expires_at  timestamptz NOT NULL,
    revoked_at  timestamptz
);

CREATE INDEX IF NOT EXISTS parent_refresh_tokens_family_idx
    ON public.parent_refresh_tokens (family_id);
-- The refresh path looks a token up by hash; it must not table-scan.
CREATE UNIQUE INDEX IF NOT EXISTS parent_refresh_tokens_hash_key
    ON public.parent_refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS parent_refresh_tokens_live_idx
    ON public.parent_refresh_tokens (family_id, expires_at)
    WHERE revoked_at IS NULL;

ALTER TABLE public.parent_refresh_tokens ENABLE ROW LEVEL SECURITY;

-- No policy for anyone. This table is touched only by the parent-session edge
-- function using the service role, which bypasses RLS. A parent must never be
-- able to read or forge one of these, and neither the anon key nor the admin
-- app has any business here.
REVOKE ALL ON public.parent_refresh_tokens FROM anon, authenticated, parent_portal;


-- ── 4. Verification ──────────────────────────────────────────
-- (a) The role holds nothing yet — expect zero rows:
-- SELECT table_name, privilege_type FROM information_schema.role_table_grants
--  WHERE grantee = 'parent_portal';
--
-- (b) The allergy shape guard rejects bad data — expect an error:
-- UPDATE students SET allergies = '[{"label":"","severity":"severe"}]'::jsonb
--  WHERE id = (SELECT id FROM students LIMIT 1);
--
-- (c) Refresh tokens are unreachable — expect permission denied:
-- SET LOCAL ROLE anon;          SELECT count(*) FROM parent_refresh_tokens;
-- SET LOCAL ROLE authenticated; SELECT count(*) FROM parent_refresh_tokens;
