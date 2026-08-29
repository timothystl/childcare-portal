-- ============================================================
-- Per-child message threads
-- ============================================================
-- design_handoff_parent_portal's README: "Messages ... Now scoped per child —
-- a pill switcher sits above the thread; switching children swaps the message
-- list. Each child has their own conversation history."
--
-- Until now this app held ONE THREAD PER FAMILY, enforced by a unique
-- constraint on message_threads.family_id. That constraint is what this
-- migration is really about: everything else follows from removing it.
--
-- ⚠️ student_id stays NULLABLE, and NULL keeps its own meaning: the family's
-- general thread, the one a family with no children on file still needs to
-- reach the office through. The parent app opens a per-child thread whenever
-- the family has children, so NULL is the exception, not the default.
--
-- Backfill is unambiguous and was measured before it was written: production
-- holds 2 threads and 2 messages, and NEITHER belongs to a family with more
-- than one child. So every existing thread has exactly one child it can
-- honestly be attributed to. The UPDATE below still guards on that count
-- rather than trusting the measurement — a thread on a multi-child family
-- stays general rather than being assigned to a child at random.

-- 1. The column ------------------------------------------------------------
alter table public.message_threads
  add column if not exists student_id uuid references public.students(id) on delete cascade;

-- 2. Drop the one-thread-per-family constraint -----------------------------
-- ⚠️ THIS is the change. Without it a second child's thread cannot be created
-- at all, and my_child_message_thread() would fail on the second call.
alter table public.message_threads
  drop constraint if exists message_threads_family_id_key;

-- 3. Backfill --------------------------------------------------------------
update public.message_threads t
   set student_id = s.id
  from public.students s
 where t.student_id is null
   and s.family_id = t.family_id
   and (select count(*) from public.students s2 where s2.family_id = t.family_id) = 1;

-- 4. Replace the constraint with the two rules that actually hold ----------
create unique index if not exists message_threads_family_student_uidx
  on public.message_threads (family_id, student_id) where student_id is not null;
create unique index if not exists message_threads_family_general_uidx
  on public.message_threads (family_id) where student_id is null;
create index if not exists message_threads_student_idx
  on public.message_threads (student_id);

-- 5. The parent's per-child thread -----------------------------------------
-- Deliberately a NEW NAME rather than an overload of my_message_thread().
-- supabase-js sends named parameters, so a 0-arg and a 1-arg function of the
-- same name are a live ambiguity risk the moment either grows a default —
-- this repo has already lost a day to exactly that on submit_incident_report.
-- my_message_thread() keeps working and keeps meaning "the general thread".
create or replace function public.my_child_message_thread(p_student_id uuid)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_family uuid; v_id bigint;
begin
    if p_student_id is null then return null; end if;
    -- Authorization is this line. The student id is never trusted: a parent
    -- asking for another family's child gets NULL, not a thread.
    if not parent_owns_student(p_student_id) then return null; end if;

    select family_id into v_family from students where id = p_student_id;
    if v_family is null then return null; end if;

    select id into v_id from message_threads
     where family_id = v_family and student_id = p_student_id;

    if v_id is null then
        insert into message_threads (family_id, student_id)
        values (v_family, p_student_id)
        on conflict (family_id, student_id) where student_id is not null do nothing
        returning id into v_id;
        -- Two tabs opening the same child at once: the loser of the race reads
        -- the winner's row rather than erroring.
        if v_id is null then
            select id into v_id from message_threads
             where family_id = v_family and student_id = p_student_id;
        end if;
    end if;

    return v_id;
end;
$$;

revoke all on function public.my_child_message_thread(uuid) from public, anon;
grant execute on function public.my_child_message_thread(uuid) to authenticated;

-- 6. Staff scoping now follows the THREAD'S child, not the family ----------
-- ⚠️ A real tightening, not just plumbing. A Bee Room teacher used to see a
-- family's single thread because ANY child of that family was in her room
-- today — including a conversation about a sibling in another room. With
-- per-child threads the right test is the thread's own child, and only a
-- general (student_id IS NULL) thread falls back to the family-wide rule.
create or replace function public.staff_can_see_thread(p_staff_id uuid, p_thread_id bigint, p_care_date date)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
    SELECT EXISTS (
        SELECT 1
        FROM message_threads t
        JOIN students st ON (
                 (t.student_id IS NOT NULL AND st.id = t.student_id)
              OR (t.student_id IS NULL     AND st.family_id = t.family_id)
             )
        JOIN registrations r       ON lower(r.child_name) = lower(st.child_name)
        JOIN registration_dates rd ON rd.registration_id = r.id
        JOIN staff s               ON s.id = p_staff_id
        WHERE t.id = p_thread_id
          AND rd.care_date = p_care_date
          AND rd.waitlisted IS NOT TRUE
          AND r.room_id = s.room_id
    );
$$;

-- 7. The staff thread list gains the child it is about ---------------------
-- DROP then CREATE: the RETURNS TABLE shape changes, and CREATE OR REPLACE
-- cannot change a function's return type.
drop function if exists public.staff_list_threads(uuid, integer, text, date);

create function public.staff_list_threads(p_staff_id uuid, p_pin integer, p_room_id text, p_care_date date DEFAULT NULL::date)
returns table(thread_id bigint, family_id uuid, family_name text, student_id uuid,
              child_name text, last_message_at timestamp with time zone,
              last_body text, unread integer)
language plpgsql
-- ⚠️ VOLATILE, explicitly. It reaches staff_id_for_pin(), which WRITES an
-- attempt row on every call, success or failure. A STABLE declaration here
-- would put PostgREST in a read-only transaction and raise 25006 on the happy
-- path only — the outage this repo already had on staff clock-in.
volatile
security definer
set search_path to 'public', 'extensions'
as $$
DECLARE v_staff uuid; v_date date;
BEGIN
    v_staff := staff_id_for_pin(p_staff_id, p_pin);
    IF v_staff IS NULL THEN RETURN; END IF;
    v_date := COALESCE(p_care_date, (now() AT TIME ZONE 'America/Chicago')::date);

    RETURN QUERY
    SELECT DISTINCT ON (t.id)
        t.id, t.family_id, f.parent_name, t.student_id, st.child_name, t.last_message_at,
        (SELECT mi.body FROM message_items mi
          WHERE mi.thread_id = t.id ORDER BY mi.created_at DESC LIMIT 1),
        (SELECT count(*)::int FROM message_items mi
          WHERE mi.thread_id = t.id AND mi.read_at IS NULL AND mi.sender_type = 'parent')
    FROM message_threads t
    JOIN families f ON f.id = t.family_id
    JOIN students st ON (
             (t.student_id IS NOT NULL AND st.id = t.student_id)
          OR (t.student_id IS NULL     AND st.family_id = t.family_id)
         )
    JOIN registrations r       ON lower(r.child_name) = lower(st.child_name)
    JOIN registration_dates rd ON rd.registration_id = r.id
    WHERE rd.care_date = v_date
      AND rd.waitlisted IS NOT TRUE
      AND r.room_id = p_room_id
    ORDER BY t.id, t.last_message_at DESC;
END;
$$;

revoke all on function public.staff_list_threads(uuid, integer, text, date) from public;
grant execute on function public.staff_list_threads(uuid, integer, text, date) to anon, authenticated;
