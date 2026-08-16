-- APPLIED AND VERIFIED IN PRODUCTION 2026-08-16.
-- ============================================================
-- ANNOUNCEMENTS — kind and audience (design handoff `1h`)
-- ============================================================
-- The table already existed with title/body/closure_id/published_at/expires_at.
-- The composer needs two more things the handoff treats as behavior rather than
-- decoration: what KIND of announcement this is, and WHO gets it.
--
-- ⚠️ `kind` IS A BRANCH, NOT A LABEL. The handoff states it plainly: "A closure
-- notice pushes to every parent's phone immediately — it ignores quiet hours.
-- Everything else waits until 7a." Whoever wires the send job must read this
-- column and honor that; a closure treated as a general notice arrives the
-- morning of the day the building is shut.
--
-- ⚠️ audience_rooms is only meaningful when audience = 'room', and the composer
-- writes '{}' for every other audience rather than leaving a stale room list
-- behind a changed dropdown. A targeted announcement that silently keeps last
-- week's rooms is worse than one with no targeting at all.
--
-- published_at IS NULL is what makes a row a draft. The pre-existing "parent
-- read published" policy tests `published_at IS NOT NULL AND published_at <=
-- now()`, so a draft is invisible to families under the same rule that hides a
-- future-dated post — no new policy needed, and no way for a draft to leak.

ALTER TABLE public.announcements
    ADD COLUMN IF NOT EXISTS kind       text NOT NULL DEFAULT 'general'
        CHECK (kind IN ('closure','general','event','billing')),
    ADD COLUMN IF NOT EXISTS audience   text NOT NULL DEFAULT 'all_families'
        CHECK (audience IN ('all_families','room','staff','everyone')),
    ADD COLUMN IF NOT EXISTS audience_rooms text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS created_by text,
    ADD COLUMN IF NOT EXISTS send_at    timestamptz;

COMMENT ON COLUMN public.announcements.kind IS
    'closure / general / event / billing. A closure notice is the only kind that ignores quiet hours.';
COMMENT ON COLUMN public.announcements.audience_rooms IS
    'Only meaningful when audience = ''room''. Empty for every other audience.';

CREATE INDEX IF NOT EXISTS announcements_published_idx
    ON public.announcements (published_at DESC) WHERE published_at IS NOT NULL;

-- ============================================================
-- VERIFIED AFTER APPLYING 2026-08-16
-- ============================================================
--   Existing policies untouched and still correct:
--     "admin any role"        ALL    to authenticated  USING is_admin()
--     "parent read published" SELECT to authenticated  USING published_at
--                             IS NOT NULL AND <= now() AND not expired
--   anon -> announcements SELECT   false
--   Table held 0 rows, so the NOT NULL defaults backfilled nothing.
--
-- ⚠️ STILL NOT WIRED, and the composer says so on screen rather than implying
-- otherwise:
--   * No push goes out. `/send-push` is called from three places in this
--     codebase and the edge function has never been deployed; those calls fail
--     silently into a catch block. Parents see an announcement next time they
--     open the portal.
--   * The closure extras ("block that day on the care calendar", "credit that
--     day's tuition") record intent only. They do not touch closures or
--     billing_invoices. Doing them for real means writing through the same
--     recompute-only billing path as everything else — never a delta.
