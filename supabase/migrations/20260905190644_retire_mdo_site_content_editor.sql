-- Retire the MDO site-content editor.
--
-- WHY, so this is not read as a rollback of something that was working: the
-- three-section editor (hero / FAQs / contact) was replaced by a screen of
-- seasonal switches over `settings`, at the director's call. The page's own
-- wording is hardcoded in index.html and changes through a developer.
--
-- ⚠ SAFE BECAUSE NOTHING WAS EVER PUBLISHED OR EDITED. Measured against
-- production before writing this: all three rows still carried
-- updated_by = '(seed)', `published` was NULL on every one of them, and
-- mdo_content_revisions held zero rows. So the public page has been rendering
-- its hardcoded markup this whole time and nothing a person typed is lost.
-- Re-check that before replaying this anywhere else:
--   select section, updated_by, published is null from mdo_site_content;
--   select count(*) from mdo_content_revisions;
--
-- The seven SECURITY DEFINER functions go with the table. Leaving them behind
-- would leave a live write path onto a table nothing reads — a small surface,
-- but one with no reason to exist.

DROP FUNCTION IF EXISTS admin_mdo_restore_revision(bigint);
DROP FUNCTION IF EXISTS admin_mdo_revisions(text);
DROP FUNCTION IF EXISTS admin_mdo_discard_draft(text);
DROP FUNCTION IF EXISTS admin_mdo_publish(text);
DROP FUNCTION IF EXISTS admin_mdo_save_draft(text, jsonb);
DROP FUNCTION IF EXISTS admin_mdo_content();
DROP FUNCTION IF EXISTS mdo_public_content();

DROP TABLE IF EXISTS mdo_content_revisions;
DROP TABLE IF EXISTS mdo_site_content;

-- The switches this screen writes are ordinary `settings` rows and need no
-- schema. `mdo_hide_banner` is seeded absent on purpose: absent means "not
-- hidden", which is exactly what the page shows today, so applying this
-- changes nothing a visitor sees.
