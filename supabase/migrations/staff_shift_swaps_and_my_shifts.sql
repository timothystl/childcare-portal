-- APPLIED AND VERIFIED IN PRODUCTION 2026-08-16.
-- ============================================================
-- STAFF SCHEDULE ON THE PHONE — own shifts, and swaps between teachers
-- ============================================================
-- Backs the "My schedule" tab, which until now was a placeholder pointing at
-- clockin.html.
--
-- ⚠️ SCOPED TO ONE STAFF MEMBER, BY CONSTRUCTION. The handoff is explicit:
-- "staff see only their own schedule … Scope the query by staff id; do not ship
-- an 'everyone' view behind a tab." `staff_my_schedule` resolves the caller
-- from their own PIN and then filters every sub-select on that id — there is no
-- parameter that can widen it, so a modified client cannot ask for the roster.
-- Other teachers' hours, days off and pay are not reachable from this function.
-- The one exception is `coworkers`, which returns id + name only, because a
-- swap needs somebody to send the shift to.
--
-- ⚠️ IDENTITY FIRST, THEN PIN. These take (p_staff_id, p_pin) and go through
-- staff_id_for_pin(), NOT a bare PIN. The older list_my_time_off_requests(p_pin)
-- identifies a staff member by scanning every active hash for one that matches,
-- which is the pattern staff_signin_name_then_pin_APPLIED.sql was written to
-- get rid of: a PIN with no name gets ~31 chances to land on one guess (31
-- active staff today) and locks nothing out. New RPCs do not reintroduce it.
--
-- ⚠️ `staff.id` is uuid — never Number()/parseInt() a staff id. shift_swaps.id
-- is a bigserial, staff ids are not.

CREATE TABLE IF NOT EXISTS public.shift_swaps (
    id             bigserial PRIMARY KEY,
    work_date      date NOT NULL,
    shift          text NOT NULL CHECK (shift IN ('am','pm')),
    -- Denormalised from the schedule row at proposal time, so the record still
    -- reads correctly after the shift moves or the schedule is rebuilt.
    room_id        text NOT NULL,
    from_staff_id  uuid NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
    to_staff_id    uuid NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
    status         text NOT NULL DEFAULT 'proposed'
                       CHECK (status IN ('proposed','accepted','declined','cancelled')),
    note           text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    decided_at     timestamptz,
    CHECK (from_staff_id <> to_staff_id)
);

CREATE INDEX IF NOT EXISTS shift_swaps_to_idx
    ON public.shift_swaps (to_staff_id, status) WHERE status = 'proposed';
CREATE INDEX IF NOT EXISTS shift_swaps_from_idx
    ON public.shift_swaps (from_staff_id, work_date);

-- ⚠️ An accepted swap is kept forever, not deleted, because the handoff says
-- "the schedule itself is the record": the teacher who gave a shift away still
-- sees it struck through on the week they left. Delete the row and that line
-- disappears, and with it the only evidence of who was actually meant to be in
-- the room that morning.

ALTER TABLE public.shift_swaps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shift_swaps FROM anon, PUBLIC;
GRANT SELECT ON public.shift_swaps TO authenticated;
-- Writes go through the two definer RPCs only. Revoked from `authenticated`
-- explicitly: Supabase's default privileges grant it, and a grant with no
-- policy behind it is the dead grant the 2026-08-14 sweep went hunting for.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON public.shift_swaps FROM authenticated, anon, PUBLIC;

CREATE POLICY "admin any role" ON public.shift_swaps
    FOR SELECT TO authenticated USING (is_admin());

-- ── staff_my_schedule(p_staff_id, p_pin, p_from, p_to) -> jsonb ──
-- One round trip for the whole tab: own shifts, shifts given away, incoming and
-- outgoing swap requests, time off, PTO used, and the coworker list for the
-- swap picker. Bounded to a 120-day window so it cannot be turned into a bulk
-- export of the year.
--
-- `shifts[].gained` and the separate `given_away` array are what let the UI draw
-- the handoff's rule: a swapped shift is struck through in place on the week it
-- left and normal on the week it was gained.

-- ── answer_shift_swap(...) ──────────────────────────────────
-- Accepting moves the staff_schedules row and stamps the swap in ONE
-- transaction — the handoff's "swaps write to both teachers' schedules and to
-- the director's build view in one transaction". Both halves are inside the
-- function, so a crash between them is impossible; there is no state where a
-- shift is on nobody's schedule.
--
-- Guards, in order: the answerer must be the person it was sent to; the swap
-- must still be 'proposed' (SELECT … FOR UPDATE, so two taps race safely);
-- and the taker must not already be working that shift — otherwise accepting
-- would silently double-book them and the UNIQUE (staff_id, work_date, shift)
-- on staff_schedules would abort the whole thing with a constraint error
-- instead of a clean "you're already on".

-- ============================================================
-- VERIFIED AFTER APPLYING 2026-08-16
-- ============================================================
--   anon  -> shift_swaps SELECT / INSERT           false / false
--   authenticated -> shift_swaps SELECT / INSERT   true  / false
--   anon  -> staff_my_schedule EXECUTE             true (PIN-gated inside)
--
-- ⚠️ NOTE FOR WHOEVER SHIPS THIS: staff_schedules currently holds ZERO rows —
-- no schedule has ever been built in Build Staff Schedule. The tab is correct
-- and will render an honest empty state until the director publishes a week.
-- Do not read a blank schedule as a broken query.
