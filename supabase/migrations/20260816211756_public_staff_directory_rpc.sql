-- ============================================================
-- public_staff_directory() — the public "Our Staff" cards, with
-- staff who have left the center filtered out server-side.
--
-- WHY AN RPC AND NOT A CLIENT-SIDE FILTER
-- The public page used to read settings.staff_directory directly and render
-- every entry. That list is maintained by hand and is NOT linked to the staff
-- roster, so deactivating someone in Staff → Staff Roster left them on the
-- website indefinitely with nobody told. (Found 2026-08-16: an assistant
-- director marked inactive was still on the home page.)
--
-- The browser cannot fix this itself. The anon policy on `staff` is
-- USING (active = true), so anon sees ONLY active staff and therefore cannot
-- distinguish "this person left" from "this person was never in the roster."
-- Widening that policy to expose inactive staff would publish a list of former
-- employees, which is worse than the bug.
--
-- So the join happens here, SECURITY DEFINER, and the function returns only the
-- already-filtered array. No new information reaches the client: the names it
-- returns are the names that were going to be printed on the page anyway.
-- This is the same posture as send-invoice — pass a reference, compose the
-- answer server-side, never let the browser widen the query.
--
-- THE RULE, and why it fails open
--   show  = the roster does not know this person  (a directory-only entry, e.g.
--           someone added to the website before payroll setup)
--        OR at least one matching roster row is active
--   hide  = the roster knows this person AND no matching row is active
-- An unmatched entry is therefore never hidden by accident. The only way to
-- disappear from the website is to exist in the roster and be inactive, which
-- is exactly the intent.
--
-- Name matching is deliberately loose in one direction only: the directory
-- carries first names ("Mary Ellen") and the roster carries full names
-- ("Mary Ellen Scheetz"), so a directory name matches a roster name it is a
-- whole-word prefix of. Two staff sharing a first name is fine — the entry
-- shows while EITHER is active, which is the safe direction.
--
-- ⚠️ settings.value is a TEXT column even when it holds JSON, so the row can
-- arrive as an array or as a JSON-encoded string. Both are handled below.
-- This is the T3 trap; do not assume a parsed object.
-- ============================================================

create or replace function public.public_staff_directory()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with d as (
    select case
             when jsonb_typeof(v) = 'array'  then v
             when jsonb_typeof(v) = 'string' then (v #>> '{}')::jsonb
             else '[]'::jsonb
           end as arr
    from (select value::jsonb as v from public.settings where key = 'staff_directory') x
  ),
  e as (
    select entry, ord
    from d, lateral jsonb_array_elements(d.arr) with ordinality as t(entry, ord)
  )
  select coalesce(jsonb_agg(entry order by ord), '[]'::jsonb)
  from e
  where
    -- unknown to the roster -> show
    not exists (
      select 1 from public.staff st
      where lower(st.name) = lower(e.entry->>'name')
         or lower(st.name) like lower(e.entry->>'name') || ' %'
    )
    -- or has at least one active match -> show
    or exists (
      select 1 from public.staff st
      where (lower(st.name) = lower(e.entry->>'name')
          or lower(st.name) like lower(e.entry->>'name') || ' %')
        and st.active
    );
$$;

-- Supabase's default privileges grant EXECUTE on a new public function directly
-- to anon, so revoking PUBLIC alone would leave that standing. Revoke both, then
-- grant back explicitly, so the grant is stated rather than inherited.
revoke all on function public.public_staff_directory() from public, anon, authenticated;
grant execute on function public.public_staff_directory() to anon, authenticated;
