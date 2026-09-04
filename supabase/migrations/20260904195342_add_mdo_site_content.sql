-- MDO public website content — editable from the admin portal.
--
-- Scope, deliberately narrow: this table holds ONLY what a visitor reads on
-- the marketing home page. It holds no child, family, registration or care
-- data, and nothing here is read by the scheduling system. A bad edit can
-- make the home page wrong; it cannot make the care system wrong.
--
-- ⚠ Classrooms, rates, fees and the staff directory are NOT here on purpose.
-- They already live in `settings` (room_rates / room_capacity / staff_ratios /
-- registration_fee / new_family_fee / staff_directory), are already edited on
-- the Settings screen, and are already server-rendered into the home page by
-- worker.js. Moving them would create a second source of truth for numbers the
-- billing path reads. Leave them where they are.
--
-- Draft vs published mirrors the church site's own pages.blocks /
-- published_blocks split: editing changes nothing a visitor sees until
-- somebody publishes.

-- ── Tables ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mdo_site_content (
  section      text PRIMARY KEY,
  draft        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- NULL means "never published". Distinct from '{}' (published as empty),
  -- because the public reader falls back to the page's own hardcoded markup
  -- when a section has never been published, and that is not the same fact
  -- as an editor having deliberately emptied it.
  published    jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text,
  published_at timestamptz,
  published_by text
);

CREATE TABLE IF NOT EXISTS mdo_content_revisions (
  id           bigserial PRIMARY KEY,
  section      text NOT NULL,
  content      jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by text
);

CREATE INDEX IF NOT EXISTS idx_mdo_content_revisions_section
  ON mdo_content_revisions (section, published_at DESC);

-- ⚠ Supabase default-grants ALL on a new public table directly to anon AND
-- authenticated, and RLS never applies to TRUNCATE — the grant alone is
-- enough. This repo has had that exact hole reopened by a new table twice
-- (NEW-1/SX1). Revoke explicitly; do not rely on RLS.
REVOKE ALL ON mdo_site_content      FROM anon, authenticated, PUBLIC;
REVOKE ALL ON mdo_content_revisions FROM anon, authenticated, PUBLIC;
REVOKE ALL ON SEQUENCE mdo_content_revisions_id_seq FROM anon, authenticated, PUBLIC;

ALTER TABLE mdo_site_content      ENABLE ROW LEVEL SECURITY;
ALTER TABLE mdo_content_revisions ENABLE ROW LEVEL SECURITY;

-- Deny-all by design: there is no policy, and every real read and write goes
-- through the SECURITY DEFINER functions below. Same posture as
-- parent_accounts / pin_reset_tokens.

-- ── Public read ──────────────────────────────────────────────────────────
-- Returns published content only. Drafts are unreachable by construction:
-- anon holds no grant on the table and this function never selects `draft`.

CREATE OR REPLACE FUNCTION mdo_public_content()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT coalesce(
    jsonb_object_agg(section, published) FILTER (WHERE published IS NOT NULL),
    '{}'::jsonb
  )
  FROM mdo_site_content;
$fn$;

REVOKE ALL ON FUNCTION mdo_public_content() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mdo_public_content() TO anon, authenticated;

-- ── Admin read ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION admin_mdo_content()
RETURNS TABLE (
  section text, draft jsonb, published jsonb,
  updated_at timestamptz, updated_by text,
  published_at timestamptz, published_by text
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- ⚠ admin_role() returns NULL, not a string, for a caller with no
  -- admin_roles entry — and a parent's own Supabase session is exactly that.
  -- `IF NULL THEN` does NOT take the branch, so an un-COALESCE'd guard falls
  -- straight through and returns the rows. Verified live once already on
  -- admin_list_staff_credentials; do not remove the coalesce.
  IF coalesce(admin_role(), '') NOT IN ('full', 'restricted') THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT c.section, c.draft, c.published,
           c.updated_at, c.updated_by, c.published_at, c.published_by
    FROM mdo_site_content c
    ORDER BY c.section;
END;
$fn$;

REVOKE ALL ON FUNCTION admin_mdo_content() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_mdo_content() TO authenticated;

-- ── Save a draft ─────────────────────────────────────────────────────────
-- Both admin tiers may edit. Publishing is `full` only (below), which is the
-- editor/publisher split without inventing a second permission system.

CREATE OR REPLACE FUNCTION admin_mdo_save_draft(p_section text, p_content jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public, pg_temp
AS $fn$
DECLARE v_who text;
BEGIN
  IF coalesce(admin_role(), '') NOT IN ('full', 'restricted') THEN
    RETURN false;
  END IF;
  -- An unknown section is refused rather than inserted: the set of sections is
  -- decided by the page's own markup, not by whatever a request names.
  IF p_section IS NULL OR p_section NOT IN ('hero', 'faqs', 'contact') THEN
    RETURN false;
  END IF;
  IF p_content IS NULL OR jsonb_typeof(p_content) <> 'object' THEN
    RETURN false;
  END IF;

  v_who := coalesce(auth.jwt() ->> 'email', '(unknown)');

  INSERT INTO mdo_site_content (section, draft, updated_at, updated_by)
  VALUES (p_section, p_content, now(), v_who)
  ON CONFLICT (section) DO UPDATE
    SET draft = EXCLUDED.draft,
        updated_at = now(),
        updated_by = v_who;

  RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION admin_mdo_save_draft(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_mdo_save_draft(text, jsonb) TO authenticated;

-- ── Publish ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION admin_mdo_publish(p_section text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public, pg_temp
AS $fn$
DECLARE v_who text; v_draft jsonb;
BEGIN
  -- Publishing changes what the public sees. `restricted` may draft; only
  -- `full` may put it in front of families.
  IF coalesce(admin_role(), '') <> 'full' THEN
    RETURN false;
  END IF;
  IF p_section IS NULL OR p_section NOT IN ('hero', 'faqs', 'contact') THEN
    RETURN false;
  END IF;

  SELECT draft INTO v_draft FROM mdo_site_content WHERE section = p_section;
  IF v_draft IS NULL THEN
    RETURN false;
  END IF;

  v_who := coalesce(auth.jwt() ->> 'email', '(unknown)');

  UPDATE mdo_site_content
     SET published = v_draft, published_at = now(), published_by = v_who
   WHERE section = p_section;

  -- One revision per publish, so an earlier version can be restored.
  INSERT INTO mdo_content_revisions (section, content, published_by)
  VALUES (p_section, v_draft, v_who);

  RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION admin_mdo_publish(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_mdo_publish(text) TO authenticated;

-- ── Discard a draft ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION admin_mdo_discard_draft(p_section text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public, pg_temp
AS $fn$
DECLARE v_who text; v_published jsonb;
BEGIN
  IF coalesce(admin_role(), '') NOT IN ('full', 'restricted') THEN
    RETURN false;
  END IF;
  SELECT published INTO v_published FROM mdo_site_content WHERE section = p_section;
  IF v_published IS NULL THEN
    RETURN false;  -- nothing published to fall back to; keep the draft
  END IF;

  v_who := coalesce(auth.jwt() ->> 'email', '(unknown)');
  UPDATE mdo_site_content
     SET draft = v_published, updated_at = now(), updated_by = v_who
   WHERE section = p_section;
  RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION admin_mdo_discard_draft(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_mdo_discard_draft(text) TO authenticated;

-- ── Revision history + restore ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION admin_mdo_revisions(p_section text)
RETURNS TABLE (id bigint, section text, published_at timestamptz, published_by text)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF coalesce(admin_role(), '') NOT IN ('full', 'restricted') THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT r.id, r.section, r.published_at, r.published_by
    FROM mdo_content_revisions r
    WHERE r.section = p_section
    ORDER BY r.published_at DESC
    LIMIT 50;
END;
$fn$;

REVOKE ALL ON FUNCTION admin_mdo_revisions(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_mdo_revisions(text) TO authenticated;

-- ⚠ Restoring lands in the DRAFT, never straight onto the live page. An
-- older version is a starting point to look at, not something to put in
-- front of families in one click without reading it.
CREATE OR REPLACE FUNCTION admin_mdo_restore_revision(p_revision_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public, pg_temp
AS $fn$
DECLARE v_who text; v_section text; v_content jsonb;
BEGIN
  IF coalesce(admin_role(), '') NOT IN ('full', 'restricted') THEN
    RETURN false;
  END IF;
  SELECT r.section, r.content INTO v_section, v_content
    FROM mdo_content_revisions r WHERE r.id = p_revision_id;
  IF v_section IS NULL THEN
    RETURN false;
  END IF;

  v_who := coalesce(auth.jwt() ->> 'email', '(unknown)');
  UPDATE mdo_site_content
     SET draft = v_content, updated_at = now(), updated_by = v_who
   WHERE section = v_section;
  RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION admin_mdo_restore_revision(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_mdo_restore_revision(bigint) TO authenticated;
