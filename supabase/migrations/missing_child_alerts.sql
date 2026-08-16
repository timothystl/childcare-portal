-- APPLIED AND VERIFIED IN PRODUCTION 2026-08-16.
-- ============================================================
-- MISSING CHILD — a broadcast, not a message
-- ============================================================
-- Handoff, Staff app §2 footer, marked as a decided behavior:
--   "🚨 Missing child — solid coral. Decided behavior: this alerts every staff
--    phone in the building at once (name, photo, room, what the child was last
--    wearing) and rings in the office. It is not a message to the director.
--    Every adult searches. Build it as a broadcast push to all staff devices
--    with an acknowledge-and-see-who's-searching state."
--
-- ⚠️ THERE IS NO RECIPIENT PARAMETER ON ANY FUNCTION HERE, AND THERE MUST NOT
-- BE ONE. raise_missing_child() takes the child and nothing else. The moment
-- this grows an audience argument it becomes a message someone can address to
-- the office and wait on, which is the exact failure the handoff calls out.
-- Every signed-in staff phone reads active_missing_child(); the director's
-- board reads active_missing_child_admin(); same row, same instant.
--
-- ⚠️ ONE ACTIVE ALERT PER CHILD. raise_missing_child returns
-- { id, already:true } for a child already being searched for rather than
-- opening a second alert. Two banners for one child splits the search and
-- makes the acknowledge list useless.
--
-- ⚠️ NO DELETE, AND 'found' IS A STATUS RATHER THAN A ROW REMOVAL. A search
-- that happened is a licensing event whether or not it ended well, and the
-- record has to survive the relief of finding the child.
--
-- ⚠️ TWO CHANNELS. (An earlier version of this header said the push leg was not
-- built and that `/send-push` did not exist. That was wrong — push lives in
-- worker.js, not supabase/functions/, and has been live for months.)
--   * In-app banner, polled every 15s. Needs no permission grant and no push
--     service to be up; this is the reliable one.
--   * Web push via worker.js `/send-staff-broadcast`, added 2026-08-16. Reaches
--     a phone in a pocket. PIN-gated, and it takes an ALERT ID rather than any
--     wording — the worker reads this table with the service role and composes
--     the message, so nothing about the notification comes from a browser.
-- Push is fired best-effort after the row is written; its failure never blocks
-- the raise. Neither channel may be removed in favor of the other.

CREATE TABLE IF NOT EXISTS public.missing_child_alerts (
    id              bigserial PRIMARY KEY,
    -- ON DELETE SET NULL, and child_name denormalised beside it: the alert is a
    -- record of a search, and it has to still name the child years later even
    -- if the student row is gone.
    student_id      uuid REFERENCES public.students(id) ON DELETE SET NULL,
    child_name      text NOT NULL,
    room_id         text,
    last_seen       text,
    wearing         text,
    raised_by_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
    raised_by_name  text,
    raised_at       timestamptz NOT NULL DEFAULT now(),
    status          text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','found')),
    found_at        timestamptz,
    found_by_name   text,
    found_note      text
);

CREATE INDEX IF NOT EXISTS missing_child_alerts_active_idx
    ON public.missing_child_alerts (raised_at DESC) WHERE status = 'active';

-- Who has answered, and where they are looking. The "where" is what stops two
-- people searching the same hallway while nobody checks the parking lot.
CREATE TABLE IF NOT EXISTS public.missing_child_acks (
    id           bigserial PRIMARY KEY,
    alert_id     bigint NOT NULL REFERENCES public.missing_child_alerts(id) ON DELETE CASCADE,
    staff_id     uuid REFERENCES public.staff(id) ON DELETE SET NULL,
    staff_name   text NOT NULL,
    searching    text,
    acked_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (alert_id, staff_id)
);

ALTER TABLE public.missing_child_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.missing_child_acks   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.missing_child_alerts FROM anon, PUBLIC;
REVOKE ALL ON public.missing_child_acks   FROM anon, PUBLIC;
GRANT SELECT ON public.missing_child_alerts TO authenticated;
GRANT SELECT ON public.missing_child_acks   TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON public.missing_child_alerts FROM authenticated, anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON public.missing_child_acks FROM authenticated, anon, PUBLIC;

CREATE POLICY "admin any role" ON public.missing_child_alerts
    FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "admin any role" ON public.missing_child_acks
    FOR SELECT TO authenticated USING (is_admin());

-- Functions, all PIN-gated through staff_id_for_pin() except the admin read:
--   raise_missing_child(staff, pin, student, last_seen, wearing) -> {id, already}
--   ack_missing_child(staff, pin, alert, searching)              -> bool
--   resolve_missing_child(staff, pin, alert, note)               -> bool
--   active_missing_child(staff, pin)                             -> jsonb[]
--   active_missing_child_admin()                                 -> jsonb[] (is_admin)

-- ============================================================
-- VERIFIED AFTER APPLYING 2026-08-16
-- ============================================================
--   anon -> missing_child_alerts SELECT / INSERT     false / false
--   authenticated -> SELECT / INSERT                 true  / false
--   anon -> active_missing_child_admin() EXECUTE     false
--   anon -> raise_missing_child() EXECUTE            true (PIN-gated inside)
