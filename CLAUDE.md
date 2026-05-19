# Childcare Portal — Claude Code Guide

## Project overview

Timothy Lutheran MDO (Mother's Day Out) registration portal. Parents register children for monthly care days; admins manage scheduling, billing, payroll, and the waitlist.

**Stack:** Vanilla JS (no framework) · Supabase (PostgreSQL + Auth + Storage) · Cloudflare Pages/Workers · esbuild for bundling.

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
`scripts/build.js` bundles all JS into minified `dist/` files and patches the HTML to reference them. Cloudflare Pages CI runs `npm run build` automatically on push to `main`.

### Deployment
Push to `main` → Cloudflare Pages builds and deploys automatically.
Edge functions in `supabase/functions/` are deployed separately via the Supabase CLI.

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
    admin-messages.js   Push notification management

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
