-- OUTAGE FIX. Parents could not submit care days.
--
-- submitRegistration() chains .insert().select() on `registrations`. R1 step 2
-- revoked anon's SELECT on that table, and PostgREST's RETURNING needs SELECT —
-- so the whole statement aborted with 42501 "permission denied for table
-- registrations" and NOTHING was written. Exactly the trap already documented
-- for the public waitlist form, shipped into the main registration path.
--
-- Fixed the same way that one was: a SECURITY DEFINER RPC with an explicit
-- column allow-list, so anon needs no SELECT on the table at all.
--
-- Bonus: the old JS inserted the registration, then the dates, and on failure
-- issued a DELETE to "roll back". That is not a transaction — a failure between
-- the two left a ghost registration with no dates. Here both inserts are one
-- statement and roll back together.

create or replace function public.submit_registration(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id      bigint;
  v_month   text;
  v_status  text;
  v_dates   jsonb := coalesce(p_payload->'dates', '[]'::jsonb);
begin
  -- Status is not free text: a caller must not be able to invent one.
  v_status := coalesce(p_payload->>'status', 'confirmed');
  if v_status not in ('confirmed', 'waitlist') then
    raise exception 'invalid status';
  end if;

  -- month_key is computed HERE from the earliest care date, not taken from the
  -- browser. It is what registrations_child_month_unique keys on, so letting
  -- the client set it would let the client sidestep duplicate prevention.
  select to_char(min((d->>'date')::date), 'YYYY-MM') into v_month
  from jsonb_array_elements(v_dates) d;

  insert into registrations (
    parent_name, parent_email, parent_phone,
    child_name, child_age, child_dob,
    room_id, status, submitted_by, month_key
  ) values (
    p_payload->>'parent_name',
    lower(trim(p_payload->>'parent_email')),
    p_payload->>'parent_phone',
    p_payload->>'child_name',
    (p_payload->>'child_age')::int,
    nullif(p_payload->>'child_dob','')::date,
    p_payload->>'room_id',
    v_status,
    coalesce(p_payload->>'submitted_by', 'parent1'),
    v_month
  )
  returning id into v_id;

  -- registration_id comes from the row just created, never from the payload,
  -- so this cannot be aimed at another family's registration.
  insert into registration_dates (registration_id, room_id, care_date, waitlisted, day_type)
  select v_id,
         coalesce(d->>'room_id', p_payload->>'room_id'),
         (d->>'date')::date,
         coalesce((d->>'waitlisted')::boolean, false),
         d->>'day_type'
  from jsonb_array_elements(v_dates) d;

  return (select to_jsonb(r) from registrations r where r.id = v_id);
end;
$$;

revoke all on function public.submit_registration(jsonb) from public;
grant execute on function public.submit_registration(jsonb) to anon, authenticated;
