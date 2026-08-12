# Scoping the `authenticated` policies to actual admins

**Status:** scoped 2026-08-11, not yet built.
**Blocks:** parent portal Option B (`docs/PARENT_PORTAL_PLAN.md`).
**Also closes:** R20 (admin roles enforced only in the browser).

---

## The finding

**27 tables are policied wide open to any `authenticated` identity** — 26 of
them `FOR ALL` (read *and* write), one (`admin_audit_log`) SELECT-only.

```
admin_audit_log, attendance_records, billing_cycles, billing_import_batches,
billing_invoices, billing_overrides, billing_payments, cacfp_claim_lines,
cacfp_claim_periods, cacfp_income_applications, cacfp_meal_records,
cacfp_menus, cacfp_reimbursement_rates, closures, deletion_requests, families,
family_rates, market_providers, messages, registration_dates, registrations,
settings, staff, staff_clock_events, staff_hours, staff_time_off_requests,
students
```

That includes staff wages and PIN hashes, the billing ledger, and the audit log
that is supposed to be tamper-evident.

**This is safe today only by accident.** The sole holders of an `authenticated`
identity are the four admins in `settings.admin_roles`. Nothing in the database
says so — it is a fact about who happens to have an account, not a boundary.

It becomes unsafe the moment anyone else gets an `authenticated` token, which is
exactly what parent portal Option B does. Hence this work blocks B.

Same class as R1, R3, R26 and R27: a role quietly holding privileges nobody
audited. The difference is that this one is aimed at a role that has not been
handed out yet — so it is fixable before it is a breach rather than after.

---

## The admin predicate

`settings.admin_roles` is a JSON object of `email → role`:

```json
{ "mdo@timothystl.org": "full", "dinger@timothystl.org": "full",
  "bookkeeper@timothystl.org": "full", "amy.b.ricketts@gmail.com": "restricted" }
```

Two `SECURITY DEFINER` helpers (definer so they can read `settings` without
being caught by the policy they are used to define — otherwise recursion, and a
total admin lockout):

```sql
CREATE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM settings s, jsonb_each_text(s.value::jsonb) kv
        WHERE s.key = 'admin_roles'
          AND lower(kv.key) = lower(COALESCE(auth.jwt() ->> 'email', ''))
    );
$$;

CREATE FUNCTION public.admin_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT kv.value FROM settings s, jsonb_each_text(s.value::jsonb) kv
     WHERE s.key = 'admin_roles'
       AND lower(kv.key) = lower(COALESCE(auth.jwt() ->> 'email', ''))
     LIMIT 1;
$$;
```

**Verified against the live settings row** (prototype query, no changes made):
all four admins resolve with the right role, matching is case-insensitive
(`DINGER@` works), and both an unknown email and a NULL email return false.

> ⚠️ **These must fail CLOSED.** `EXISTS` over an empty or missing
> `admin_roles` returns false, which locks admins out — loudly, and fixable by
> restoring the setting. That is the correct direction. FS10 records the
> opposite bug in `admin-users`, which fails **open** when `admin_roles` is
> empty; fix that at the same time so the two agree.

---

## Table tiers

**Tier 1 — admin only, `full` role.** Wages, payroll, money, audit. No parent
ever touches these, and a `restricted` or `staff` admin should not either.
Enforcing that here is what closes R20.

> `staff`, `staff_hours`, `staff_clock_events`, `billing_cycles`,
> `billing_invoices`, `billing_payments`, `billing_overrides`,
> `billing_import_batches`, `family_rates`, `admin_audit_log`, `market_providers`,
> all seven `cacfp_*`

**Tier 2 — admin only, any role.** Operational data the admin app needs
regardless of role tier.

> `deletion_requests`, `staff_time_off_requests`, `attendance_records`

**Tier 3 — shared with the parent portal.** Admin keeps full access; parents get
a *separate* policy `TO parent_portal` scoped by `family_id`. These are the
tables Phase 1 builds on, so do them as part of Phase 1 rather than ahead of it.

> `families`, `students`, `registrations`, `registration_dates`,
> `billing_invoices` (read-only for parents), `messages`, `attendance_records`

**Tier 4 — `settings`, which needs splitting by key.** It holds `room_rates`
(harmless, needed for display) *and* `admin_roles` (the list of who is an
admin). A blanket parent read would hand out the admin roster. Policy must be
key-scoped: parents read an allow-list of keys, admins read all.

**Tier 5 — `closures`.** Already has a separate anon read policy for the public
calendar. Only the `authenticated` write side needs scoping.

---

## Staged plan

Each stage is independently applyable and reversible. **Do not do them in one
migration** — a mistake in the predicate locks every admin out of every tool.

1. **Helpers only.** Create `is_admin()` / `admin_role()`. Change no policies.
   Verify they return the right answer for all four admins. Zero risk.
2. **Tier 1 and 2.** Convert to `USING (is_admin())`, with the `full`-only
   subset using `admin_role() = 'full'`. Highest value, no parent involvement,
   and the tables least likely to have a surprise reader.
3. **Tier 4.** Split `settings` by key.
4. **Tier 5.** Scope the `closures` write side.
5. **Tier 3.** Deferred into Phase 1, where the parent policies are written
   alongside the admin ones so both are designed together.

Only after stages 1–4 does parent portal Option B become safe to build.

---

## Risks

- **Admin lockout is the main one.** Every admin tool reads these tables through
  the anon key plus a Supabase Auth session, i.e. as `authenticated`. If the
  predicate is wrong, the whole admin app goes dark at once. Mitigation: stage 1
  proves the predicate before any policy moves; each later stage is one table
  group with its own rollback; smoke-test admin after each.
- **Recursion on `settings`.** `is_admin()` reads `settings`, and `settings` will
  itself be policy-protected. `SECURITY DEFINER` is what prevents the loop — it
  is not optional here.
- **Edge functions are unaffected.** They use the service role, which bypasses
  RLS entirely.
- **`restricted` and `staff` admins will genuinely lose access** to finance and
  payroll once stage 2 lands. That is the point — today it is hidden in the
  browser only — but it is a behaviour change for `amy.b.ricketts@gmail.com`,
  who is `restricted`. Tell her before, not after.

---

## Prerequisite for Option B, separately

One email is shared by two parent records. `auth.users` requires unique emails,
so that family must be reconciled before any parent gets an auth identity. All
121 active families have a primary email, so nothing else blocks it.
