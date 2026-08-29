-- ============================================================
-- my_app_home() — which app this signed-in session belongs to
-- ============================================================
-- An admin who opens portal.html with an existing Supabase Auth session lands
-- in the parent app with no family behind it: "Good morning, there.", a
-- not-a-parent notice, and every tab either empty or reporting a load failure
-- that retrying can never fix (my_schedule() returns the jsonb 'null' for a
-- caller with no parent_accounts row, so Billing and Schedule both fell into
-- their "could not load" branch). Reported live twice in one morning.
--
-- This returns the app the CALLER belongs to, so the portal can send them
-- there instead of stranding them.
--
-- ⚠️ PARENT WINS, and the order below is the whole point. An admin or staff
-- member who ALSO has a child enrolled is on the parent portal deliberately;
-- bouncing them to the admin app because they happen to be in admin_roles
-- would be a worse bug than the one this fixes. Today the director's two
-- addresses are separate accounts, but mdo@ or a teacher-parent could hold
-- both tomorrow.
--
-- ⚠️ NOT an enumeration oracle. Every branch reads auth.uid() / auth.jwt()
-- for the caller's OWN session — there is no parameter, so it cannot be
-- pointed at somebody else's address to ask whether they are staff.
--
-- ⚠️ Staff currently have no Supabase Auth accounts at all (the staff app is
-- PIN-gated, and 0 of 7 auth users match a staff email), so the 'staff' branch
-- is unreachable today. It is here because the rule should hold if an admin
-- ever provisions one, not because it fires now.
create or replace function public.my_app_home()
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
    select case
        when exists (
            select 1 from parent_accounts pa where pa.user_id = auth.uid()
        ) then 'parent'
        when is_admin() then 'admin'
        when exists (
            select 1 from staff s
            where coalesce(auth.jwt() ->> 'email', '') <> ''
              and lower(s.email) = lower(auth.jwt() ->> 'email')
              and s.active
        ) then 'staff'
        else null
    end;
$$;

revoke all on function public.my_app_home() from public, anon;
grant execute on function public.my_app_home() to authenticated;
