# Childcare Portal — Claude Code Guide

## Git branch naming

Always use descriptive branch names in the format `type/short-description` (e.g. `fix/billing-change-fees`, `feat/add-goose-room`, `chore/update-deps`). Never use auto-generated random names.

---

## PR workflow

`.github/workflows/auto-merge-claude.yml` auto-merges any push to a `claude/**` branch straight into `main` (and deploys) — no human action required, no draft PR needed to unblock the merge. When working in a cloud session (feature branch required by session config), push your work, then still open the PR via the GitHub MCP tool for visibility/history — by the time it's created, CI will typically have already merged the branch into `main`, so the PR will show as merged automatically. Don't wait on or babysit a PR here expecting it to need manual merging; if CI hasn't picked it up yet, that's a CI issue to flag, not something to leave sitting as a draft for the user to click a button on.

---

## Version numbering

The app version uses **semantic versioning** (`major.minor.patch`) stored in `package.json`.

**For every PR, run `npm run bump` before committing.** This script increments the patch version in both `package.json` and `js/build-version.js` atomically — never edit either file by hand.

```bash
npm run bump          # patch: 1.13.2 → 1.13.3
```

`js/build-version.js` is what the live site actually reads (bundled or not), so both files must stay in sync. The `bump` script guarantees that.

For minor or major bumps (new features, breaking changes), edit `package.json` manually first, then run `npm run bump` to sync `js/build-version.js`, or just edit the version number in both files together.

| Change type | When to use |
|---|---|
| `patch` | Bug fixes, small tweaks (use `npm run bump`) |
| `minor` | New features, meaningful additions |
| `major` | Radical redesigns, breaking changes (reserved for 2.0.0) |

**End every coding-task response (in this repo or any other) with the resulting version number** (e.g. "Current version: v1.17.6") so it's always clear what's live after a change.

---

## Project overview

Timothy Lutheran MDO (Mother's Day Out) registration portal. Parents register children for monthly care days; admins manage scheduling, billing, payroll, and the waitlist.

**Stack:** Vanilla JS (no framework) · Supabase (PostgreSQL + Auth + Storage) · Cloudflare Pages/Workers · esbuild for bundling.

---

## Project status & outstanding work (updated 2026-06-05)

A full code review + a deeper "second sweep" were done. Detailed records live in:
- **`docs/CODE_REVIEW.md`** — all findings, labeled (S/U/V/N/P/Q/C/M for the first
  review; SS1–SS19 for the correctness/integrity sweep), with `[x]`/`[~]`/`[ ]` status.
- **`docs/NEXT_STEPS.md`** — the prioritized action plan + an incident log.
- **`CONTRIBUTING.md`** — branch/deploy rules (read before merging).

### Done & shipped
- First-review fixes (escaping, focus states, ARIA, design tokens, init/`MONTH_NAMES`/
  `parseJsonOr` dedup, billing dedup, etc.) and several SS items (SS6 month_key query,
  SS7 staff-save button, SS14 recurring-days, SS15 multi-room selector). All on `main`.
- **DB applied in prod:** `hash_staff_pins.sql` (staff PINs now bcrypt-hashed — they had
  never been applied; the deployed kiosk depended on them), SS10
  `harden_definer_search_path.sql`, SS12 `ss12_one_open_clock_event.sql`.
- **Edge/worker:** SS4 (`send-waitlist-offer` now requires admin auth) deployed; SS13
  worker email-filter validation auto-deployed via the workflow.
- **SS2 DONE** — family PINs are text end-to-end: `ss2_family_login_text_pin.sql` applied,
  `family-lookup` edge fn redeployed, `familyLogin` JS shipped. Leading-zero PINs (e.g.
  `0123`) now log in (verified). Staff PINs are a separate int-based system, untouched.
- **CI:** `.github/workflows/auto-merge-claude.yml` now auto-resolves version-file
  (`package.json` + `js/build-version.js`) merge conflicts — those were silently failing
  every auto-merge/deploy when two `claude/**` branches ran at once.

### Still to do (see NEXT_STEPS.md for the exact steps/sequencing)
- **SS1** — anon-read PII exposure: the public anon key can still read/modify
  families/students/staff (policies were over-permissive; a blanket tighten broke login
  and was rolled back). Groundwork RPCs are in `ss1_public_read_rpcs.sql`; the staged
  switch + policy drops still need a staging session.
- **SS5** likely moot (the billing-by-email RPCs aren't deployed in prod — verify).
- Remaining: SS3/SS9 (atomic registration RPC + capacity), SS11/SS16/SS17/SS18, SS19,
  S6 (PIN-reset per-IP throttle), S8 (anon-key rotation), and the browser-verified UX/perf
  items (U3/U4, V2–V6, P1–P3, M1). (S2 ✅, S4 ✅ closed by disabling Supabase signups,
  S7 reviewed-as-moot.)
- **`send-schedule-confirmation`** edge fn (SS13) still needs deploying.

### Hard-won operational notes (don't repeat these)
- **`supabase/migrations/` is NOT auto-applied** — run migrations by hand in the SQL
  Editor. A committed migration ≠ a deployed one. Confirm a new RPC/column exists
  (`pg_proc` / `information_schema.columns`) before deploying code that needs it.
- **Auth/billing/RLS changes:** stage + smoke-test (parent login, kiosk, a test
  registration, admin tabs) before prod.
- **Don't run two `claude/**` branches editing shared files at once** — that caused a
  silent revert of a `supabase.js` line and the version-conflict merge failures. Sync
  with `main` before pushing.

---

## Development workflow

### Local dev (no build needed)
HTML pages load source files from `js/` directly. Open any `.html` in a browser or run:
```bash
python3 serve.py   # simple local server on :8000
```

### Building for production
```bash
npm run build        # one-shot — outputs to dist/
npm run build:watch  # watch mode
```
`scripts/build.js` bundles all JS into minified `dist/` files and patches the HTML to reference them (the HTML loads `dist/*.min.js`, not the `js/` source).

> ⚠️ **The deploy has NO build step.** Cloudflare Workers (`wrangler.jsonc` →
> `assets.directory "."`) serves the repo's files directly as static assets.
> Nothing runs `npm run build` on the server. Therefore **`dist/*.min.js` is
> committed to git**, and **you MUST run `npm run build` and commit the updated
> `dist/` whenever you change anything in `js/`** — otherwise the live site keeps
> serving the old bundle (or, if a referenced bundle is missing, 404s and the
> page's JS silently doesn't run at all). The idempotent `patchHtml` step keeps
> the HTML `<script>` tags from duplicating across rebuilds. Sourcemaps
> (`dist/*.map`) stay gitignored.

### Deployment
Push to `main` → Cloudflare Workers serves the committed files (including the
committed `dist/` bundles). **Rebuild + commit `dist/` before pushing JS changes.**
Edge functions in `supabase/functions/` are deployed separately (paste into the
Supabase dashboard editor, or `supabase functions deploy <name>`).

---

## File structure

```
admin.html          Admin dashboard (password-protected via Supabase Auth)
index.html          Parent registration portal
calendar.html       Monthly calendar view (parent-facing)
clockin.html        Staff clock-in/out kiosk
enroll.html         Enrollment info + PDF forms
lookup.html         Family schedule lookup
reset-pin.html      PIN reset flow
notice.html         School notices

js/
  supabase.js       Supabase client, ROOMS config, all DB helper functions
  app.js            Parent registration logic
  lookup.js         Family lookup page
  admin/
    admin-init.js       Admin auth & initialization
    admin-core.js       Shared admin utilities (escHtml, showToast, etc.)
    admin-calendar.js   Registration list, edit-days, add-a-day modal
    admin-classrooms.js Room roster (daily attendance view)
    admin-families.js   Family/child management, search, import
    admin-waitlist.js   Waitlist applications management
    admin-staffing.js   Staff roster, schedule planner, clock-in log
    admin-reports.js    Payroll report, attendance/revenue report
    admin-finance.js    Finance dashboard, P&L, expense modeling
    admin-settings.js   Room rates, closures, admin roles, settings

css/
  styles.css        Shared styles
  admin.css         Admin-only styles
  lookup.css        Lookup page styles

supabase/
  migrations/       SQL migrations (apply manually in Supabase SQL Editor)
  functions/        Edge functions (TypeScript)
    admin-users/         Admin user CRUD via Supabase Auth Admin API
    family-lookup/       Authenticated family lookup by email+PIN
    request-pin-reset/   PIN reset email flow
    send-schedule-confirmation/
    send-schedule-change/
    send-waitlist-offer/

scripts/
  build.js          esbuild bundler config
```

---

## Rooms (ROOMS constant in js/supabase.js)

| ID | Label | Ages | Status |
|----|-------|------|--------|
| `bear` | 🐻 Bear Room | Birth–12 mo | active |
| `bee` | 🐝 Bee Room | 12–24 mo | active |
| `turtle` | 🐢 Turtle Room | 24–30 mo | active |
| `goose` | 🪿 Goose Room | 30–36 mo | coming_soon |
| `owl` | 🦉 Owl Room | 36+ mo | active |
| `summer` | ☀️ Summer Camp | 4–9 years | seasonal |

Rates are stored in the `settings` table (key = `room_rates`) and merged into `ROOMS` at runtime. Admin can edit them in Settings → Rates & Settings.

---

## Key database tables

| Table | Purpose |
|-------|---------|
| `registrations` | One row per child-per-month submission (parent info, child info, room) |
| `registration_dates` | Individual care dates per registration (care_date, day_type, waitlisted) |
| `families` | Parent records (registration_locked, login_locked, has_pin, parent2 fields) |
| `students` | Child records linked to families (child_name, child_dob, room_override, recurring_days) |
| `staff` | Staff roster (pay_type, hourly_rate, salary_biweekly, role, room_id) |
| `staff_clock_events` | Clock in/out records (clock_in, clock_out, work_date) |
| `staff_hours` | Manual payroll hour entries (work_date, hours_worked, notes) |
| `staff_schedules` | Staff schedule slots |
| `billing_summary` | Historical billing snapshots per child/month |
| `billing_overrides` | Per-child custom billing amounts |
| `settings` | App-wide config (key/value JSONB): room_rates, offer_links, enrollment_forms, etc. |
| `admin_audit_log` | Admin action audit trail |
| `waitlist_applications` | Waitlist entries |
| `closures` | School closure dates |
| `pin_reset_tokens` | One-time PIN reset tokens |
| `push_subscriptions` | Web push subscriptions (family_id → endpoint) |
| `client_error_log` | Client-side JS errors |
| `deletion_requests` | Family data deletion requests |

Migrations are in `supabase/migrations/` and must be applied manually in the Supabase SQL Editor (there is no CLI migration runner configured).

---

## Admin roles

Three access levels (stored in `settings` key `admin_roles`):

- **full** — unrestricted access to all tabs
- **restricted** — schedule planner only; no Finance, no Payroll, no Staff Roster, limited Settings
- **staff** — Classrooms tab only (read-only roster view)

---

## Important patterns

### Search
All search fields check **child name first**, then parent name(s), then email. Functions:
- `onFamilySearch()` — families tab (child_name, parent_name, parent2_name)
- `applyFilters()` — calendar registration list (child_name, parent_name, parent_email)
- `_arRunSearch()` — admin register modal (child_name, parent_name, parent2_name, parent_email)
- `_aadRunSearch()` — add-a-day modal (child_name, parent_name)
- `renderWaitlistQuickList()` — waitlist tab has a text search (child_name, parent_name, parent_email)

### Registration duplicate prevention
`checkExistingRegistration(email, monthKey, childName)` — blocks same email re-submitting.
`checkExistingRegistrationByChild(monthKey, childName)` — blocks any parent from registering a child already scheduled for that month by another parent. Both are called in sequence before `submitRegistration()` in `app.js`.

### Payroll detail rows
`_buildPayrollData()` builds `periodDetailMap` (staff_id → [{work_date, hours, source, events}]).
`events` is an array of `{clockIn, clockOut}` ISO timestamps from `staff_clock_events`. The rendered detail rows (click-to-expand in payroll report) show formatted in/out times when `events` is non-empty.

### Pay types
Staff can be `hourly` (rate × hours) or `salary` (fixed biweekly amount). The payroll report handles both. Clock events are ignored for salary staff.

### Registration window
Enforced by a Postgres trigger (`enforce_registration_window.sql`). The window is defined by the `registration_window` setting. Attempting to submit outside the window raises a `P0001` error caught in `app.js`.

---

## Environment / secrets

Set as Cloudflare Pages environment variables and Supabase Edge Function secrets:
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` — injected into HTML at build time or via `_headers`
- `SUPABASE_SERVICE_ROLE_KEY` — used by edge functions only (never exposed to browser)
- Push notification VAPID keys — set as edge function secrets

---

## Common tasks

**Add a new room:** Add an entry to the `ROOMS` array in `js/supabase.js`. The room will appear automatically in registration, admin calendar, rates table, and reports.

**Apply a DB migration:** Paste the SQL from `supabase/migrations/` into the Supabase SQL Editor and run it.

**Deploy an edge function:** Use `supabase functions deploy <function-name>` from the repo root (requires Supabase CLI and project linked).

**Change payroll period length:** Adjust the `14` constant in `_buildPayrollPeriodList()` in `admin-reports.js`.
