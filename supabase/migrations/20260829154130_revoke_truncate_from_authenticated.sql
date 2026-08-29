-- Revoke TRUNCATE on every public table from anon and authenticated.
--
-- ⚠️ RLS DOES NOT STOP TRUNCATE. This is the 2026-08-14 finding
-- (revoke_anon_delete_truncate_sweep.sql) and the 2026-08-19 NEW-1/SX1 finding
-- (admin_push_subscriptions), reopened one role over: TRUNCATE reads no rows,
-- so no policy is ever consulted — holding the grant is sufficient. `anon` was
-- swept clean twice; `authenticated` never was, because at the time every
-- authenticated session was an admin.
--
-- That stopped being true on 2026-08-12, when parent_portal_option_b_accounts
-- gave families real Supabase Auth accounts. Measured before this migration:
-- 48 of 67 public tables let ANY signed-in parent run
-- `TRUNCATE families` / `registrations` / `billing_invoices` / `settings` /
-- `staff_clock_events` — no soft delete, no application copy, recovery would be
-- a database restore.
--
-- ⚠️ DELETE is deliberately left alone. DELETE reads rows, so RLS does apply to
-- it, and admin paths in this app legitimately delete (a cancelled
-- registration, a removed pickup contact). TRUNCATE has no caller anywhere:
-- verified by grepping js/, supabase/functions/ and worker.js — the word does
-- not appear outside migrations that revoke it.
do $$
declare t record;
begin
    for t in
        select c.oid::regclass as tbl
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
    loop
        execute format('revoke truncate on %s from anon, authenticated, public', t.tbl);
    end loop;
end $$;

-- And stop the next new table from reopening it.
--
-- Supabase's default privileges for a new public table are `arwdDxtm` to anon
-- AND authenticated — the D is TRUNCATE — which is why add_admin_push_subscriptions
-- shipped with the grant three days after the sweep that was meant to close it.
-- CLAUDE.md's rule ("every new-table migration needs an explicit REVOKE") is a
-- rule a person has to remember; this makes the default itself correct.
--
-- ⚠️ Only the `postgres` default ACL can be changed from here: postgres is not
-- a member of supabase_admin (checked), so the supabase_admin default ACL for
-- schema public still carries the D bit. A table created by that role would
-- still need the explicit revoke — keep the rule as well as this.
alter default privileges for role postgres in schema public
    revoke truncate on tables from anon, authenticated;
