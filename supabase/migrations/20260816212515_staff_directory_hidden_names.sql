-- ============================================================
-- Show the director WHY a staff card is missing from the website.
--
-- public_staff_directory() (applied 2026-08-16) hides directory entries whose
-- roster row is inactive. That is the right behavior, but it was invisible from
-- the admin side: in Staff → Staff Directory a hidden person looked exactly like
-- a shown one, so "why isn't she on the site?" had no answer on screen.
--
-- ⚠️ THE POINT OF THIS MIGRATION IS THE SHARED HELPER, NOT THE NEW FUNCTION.
-- The obvious implementation was to re-derive "is this entry hidden" in
-- admin-settings.js. That would put the rule in two places — SQL and JS — and
-- the moment they disagreed the editor would confidently mislabel who is on the
-- website, which is worse than showing nothing. So the rule moves into
-- _staff_directory_annotated() and BOTH callers read it:
--
--   _staff_directory_annotated()      <- the rule, stated once
--     ├── public_staff_directory()    <- the page: entries where not hidden
--     └── staff_directory_hidden_names() <- the editor: names where hidden
--
-- Rewriting public_staff_directory() in terms of the helper is therefore part of
-- the change, not incidental cleanup. Its behavior is unchanged.
--
-- The rule itself (unchanged): hidden iff the roster knows this person AND no
-- matching roster row is active. Unknown to the roster => shown, so a
-- directory-only entry is never hidden by accident. Directory names are first
-- names and roster names are full names, so a directory name matches a roster
-- name it is a whole-word prefix of; two staff sharing a first name keeps the
-- card visible while either is active.
--
-- ⚠️ settings.value is TEXT even when it holds JSON — array or JSON-encoded
-- string. Both handled. This is the T3 trap.
-- ============================================================

-- The rule, stated once. Internal: no EXECUTE for anon or authenticated. The two
-- wrappers below are SECURITY DEFINER, so their calls into this run as the owner
-- and need no grant of their own.
create or replace function public._staff_directory_annotated()
returns table (entry jsonb, ord bigint, hidden boolean)
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
    select t.entry, t.ord
    from d, lateral jsonb_array_elements(d.arr) with ordinality as t(entry, ord)
  )
  select
    e.entry,
    e.ord,
    (
      exists (
        select 1 from public.staff st
        where lower(st.name) = lower(e.entry->>'name')
           or lower(st.name) like lower(e.entry->>'name') || ' %'
      )
      and not exists (
        select 1 from public.staff st
        where (lower(st.name) = lower(e.entry->>'name')
            or lower(st.name) like lower(e.entry->>'name') || ' %')
          and st.active
      )
    ) as hidden
  from e;
$$;

revoke all on function public._staff_directory_annotated() from public, anon, authenticated;

-- The public page. Behavior identical to the 2026-08-16 version; only the source
-- of the rule moved.
create or replace function public.public_staff_directory()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(entry order by ord), '[]'::jsonb)
  from public._staff_directory_annotated()
  where not hidden;
$$;

revoke all on function public.public_staff_directory() from public, anon, authenticated;
grant execute on function public.public_staff_directory() to anon, authenticated;

-- The editor badge. Returns only the names already present in the directory the
-- admin is looking at, so it tells them nothing they cannot already see —
-- but it is still gated on is_admin(), because "who stopped working here" is not
-- anon's business and R20 means the browser's role check cannot be trusted.
create or replace function public.staff_directory_hidden_names()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when public.is_admin() then coalesce(
      (select jsonb_agg(entry->>'name' order by ord)
         from public._staff_directory_annotated()
        where hidden),
      '[]'::jsonb)
    else '[]'::jsonb
  end;
$$;

-- Supabase's default privileges grant EXECUTE on a new public function directly
-- to anon, so revoking PUBLIC alone leaves that standing. Revoke both, then grant
-- back only what is intended.
revoke all on function public.staff_directory_hidden_names() from public, anon, authenticated;
grant execute on function public.staff_directory_hidden_names() to authenticated;
