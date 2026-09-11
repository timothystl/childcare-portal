# Architecture

myMDO is one product spanning public childcare information, registration, family/parent access,
classrooms, staff operations, attendance, schedules, billing/payments, messaging, and approved MDO
payroll inputs.

Cloudflare Worker `childcare-portal` starts at `worker.js` and serves committed static assets. The
source JavaScript lives under `js/`; production serves generated committed bundles under `dist/`.
`wrangler.jsonc` routes only `/` and `/index.html` through the Worker before static assets so the
server-rendered home page and response controls run without charging every asset request.

Supabase project `dahdstopsumxnqvdclmy` owns Postgres, Auth, Storage, Edge Functions, and scheduled
jobs. Migrations under `supabase/migrations/` are source records but are not automatically applied
by the GitHub workflow. Edge gateway JWT posture is declared in `supabase/config.toml`; functions
that disable gateway verification must implement their own explicit authentication.

The public hostname is `mdo.timothystl.org`. A future repository rename is a separate
non-functional change, not part of ordinary feature work.

## Frontend module map (`js/`)

Build runs with `bundle:false` — every file below loads as a separate `<script>` tag on whichever
page needs it, and top-level declarations in one stay global to the others loaded on the same page
(`js/supabase.js` loads first on every page and its `MONTH_NAMES`/`ROOMS` constants are used by
`app.js` this way).

| File | Purpose |
|---|---|
| `supabase.js` | By far the largest file (5,700+ lines): the shared Supabase client, room/rate config (`ROOMS`, overridable via the `settings` table), and effectively the whole business-logic layer every page script calls into. |
| `app.js` | The main parent/staff portal app (2,000+ lines): calendar, enrollment, scheduling state. |
| `lookup.js` | Parent Portal — "My Schedule" lookup. |
| `waitlist-status.js` | Parent Portal — waitlist status, looked up by email only (no PIN). |
| `inquiry.js` | Standalone public waitlist inquiry form. |
| `confirm-interest.js` | Public "Still interested?" response page linked from tour-reminder emails. |
| `menu.js` | Public, read-only weekly CACFP menu page — no login. |
| `reset-pin.js` | Self-service PIN reset page, reached from the link the `request-pin-reset` Edge Function emails. |
| `push-notifications.js` | Requests push permission with a soft in-page prompt after a successful family login (not the native browser dialog). |
| `app-update.js` | Detects a new deploy and prompts a refresh when the PWA is resumed — a home-screen PWA has no compiled bundle to force a refresh otherwise. |
| `error-monitor.js` | Captures uncaught errors/unhandled rejections and reports them. |
| `statement-print.js` | Printable childcare statement (`statement-print.html?family=<uuid>&from=...&to=...`). |
| `incident-print.js` | Printable, signed incident report — one US Letter page, portrait. |
| `build-version.js` | Generated build-version stamp. |

## Worker (`worker.js`)

Beyond serving static assets, `worker.js` handles:

- **`/sb/*`** — a same-origin proxy to Supabase, purely to work around CORS from the browser. This
  is unrelated to `chms`'s or `website`'s own `/sb/*`/service-binding proxies — the shared prefix
  is coincidental, not a cross-repo integration.
- Push subscription and send routes (`/push-subscribe`, `/staff-push-subscribe`,
  `/admin-push-subscribe`, `/send-push`, `/send-staff-push`, `/send-staff-broadcast`) and
  staff/admin notification triggers (`/notify-admin-message`, `/notify-admin-incident`).
- Clean-URL handling (strips `.html`) and a couple of named page routes (`/calendar`, `/enroll`).
- The public anon key is inlined here as a documented fallback only (see the file's own `⚠️`
  comment) — prefer the `SUPABASE_ANON_KEY` binding; never put the service-role key here or
  anywhere in source.

## Supabase Edge Functions (`supabase/functions/`)

| Function | Purpose |
|---|---|
| `parent-session` | Parents as real Supabase Auth users (the design doc calls this "Option B"). |
| `family-lookup` | Issues a 1-hour HMAC-SHA256 token the Worker validates before saving a push subscription. |
| `request-pin-reset` / (paired with `js/reset-pin.js`) | Self-service PIN reset flow. |
| `admin-users` | Admin user management. |
| `submit-staff-credential` | Staff submit CPR/first-aid/TB-test records with their own attached scan/photo. |
| `check-missed-clocks` | Scheduled: flags shifts with no clock-out inside their shift window. |
| `upload-child-photo` / `sweep-child-photos` | Staff post day-feed photos; a scheduled sweep enforces one-week retention. |
| `send-day-summary` | One end-of-day notification per family. |
| `send-schedule-confirmation` / `send-schedule-change` / `send-staff-schedule` | Schedule-related family/staff notifications. |
| `notify-geofence` / `notify-new-message` | Real-time notification triggers. |
| `send-invoice` | Emails a family their monthly invoice. |
| `send-waitlist-offer` / `send-waitlist-confirmation` / `send-waitlist-reminders` / `confirm-waitlist-interest` / `waitlist-status` | The waitlist lifecycle: offer, confirm, periodic reminders, and status lookup. |
| `finance-summary` | Builds a trailing 12-month revenue summary from the `settings` table — the kind of narrow, approved summary Finance may consume per this repo's boundary rule (see `AGENTS.md`); it does not hand over raw billing/family records. |
| **Payments (Stax):** | |
| `create-stax-charge` | Starts a Stax (Fattmerchant) payment. |
| `charge-stax-payment` | Actually moves money. |
| `admin-refund-stax-payment` | Reverses one online Stax card payment. |
| `stax-webhook` | Verified, atomic recording of a Stax transaction. |
| `reconcile-stax-payments` | Safety net for a webhook that never arrived. |
| `stax-webhook-admin-tmp` | **Correction to prior documentation**: an earlier architecture note (see the `digital-architecture` repo's overhaul plan) flagged this as a live, "temporary"-named function still handling payments and worth a deliberate look. Current code shows it was already replaced with an inert stub — it now unconditionally returns `410 Gone` with a comment describing it as the emergency replacement for a version that "previously contained a hardcoded administrator token and could create Stax charges and refunds." Delete it from the Supabase dashboard rather than treating it as a live payment path. |
| `_shared/cron-auth.ts` | Shared helper: authenticates `pg_cron` scheduled calls via a constant-time-compared `X-Cron-Secret` header, so scheduled jobs don't need a service-role JWT. |

## Auth model

Three separate identities, deliberately not unified:

- **Parents** — real Supabase Auth users (`parent-session`), separate from staff/admin.
- **Staff** — PIN-based clock-in/kiosk flows, rate-limited and fail-closed per `AGENTS.md`.
- **Admin** — `admin-users` function; role/permission enforcement happens in RLS, RPCs, and Edge
  Functions, never only in what the client hides.

## Payments

Stax is the only current processor (Authorize.net was retired by migration
`20260830211423_retire_authorizenet_processor.sql`). The browser never determines the amount
charged or the authoritative result — `charge-stax-payment` and `stax-webhook` do, and
`reconcile-stax-payments` exists specifically because a webhook can be missed.
