-- Surface allergies_reviewed_at to the staff app so its safety panel can tell
-- "checked, no allergies" from "nobody has looked yet". Column appended at the
-- end; every existing output keeps its position, so the JS reading by name is
-- unaffected either way.
--
-- ⚠️ Adding a column to a RETURNS TABLE requires DROP, not CREATE OR REPLACE
-- (42P13: cannot change return type of existing function).
drop function if exists public.list_room_children(uuid, integer, text, date);

create function public.list_room_children(
    p_staff_id uuid, p_pin integer, p_room_id text, p_care_date date default null
)
returns table (
    student_id uuid, child_name text, allergies jsonb, care_notes text,
    photo_release boolean, checked_in boolean, allergies_reviewed boolean
)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare v_staff_id uuid; v_date date;
begin
    v_staff_id := staff_id_for_pin(p_staff_id, p_pin);
    if v_staff_id is null then return; end if;
    v_date := coalesce(p_care_date, (now() at time zone 'America/Chicago')::date);

    return query
    select distinct on (st.id)
        st.id, st.child_name, st.allergies, st.care_notes, st.photo_release,
        exists (select 1 from child_day_events e
                where e.student_id = st.id and e.care_date = v_date
                  and e.event_type = 'check_in') as checked_in,
        (st.allergies_reviewed_at is not null) as allergies_reviewed
    from registrations r
    join registration_dates rd on rd.registration_id = r.id
    join students st on lower(st.child_name) = lower(r.child_name)
    where rd.care_date = v_date and rd.waitlisted is not true and r.room_id = p_room_id
    order by st.id, st.child_name;
end;
$function$;

revoke all on function public.list_room_children(uuid, integer, text, date) from public;
grant execute on function public.list_room_children(uuid, integer, text, date) to anon, authenticated;
