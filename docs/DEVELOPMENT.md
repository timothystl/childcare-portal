# Local development

myMDO splits across two runtimes, and "local development" means something different in each:

- **Cloudflare Worker `childcare-portal`** (`worker.js` + `wrangler.jsonc`) — serves the committed
  static HTML/CSS/JS and handles a handful of routes (`/sb/*` Supabase proxy, push
  subscribe/send, clean-URL rewriting). It has no D1, R2, or KV of its own.
- **Supabase project `dahdstopsumxnqvdclmy`** — owns Postgres, Auth, Storage, all ~27 Edge
  Functions under `supabase/functions/`, and the `pg_cron` scheduled jobs. This is where almost
  all real business logic, RLS, and payment handling lives.

Nearly everything a contributor touches day to day is Supabase-side code (an Edge Function, a
migration, an RLS policy) or plain frontend JS under `js/`; the Worker itself changes rarely.

## Loop 1: `npm test` — the fast loop, no Supabase project needed

```sh
npm ci
npm test
npm run build
git diff --exit-code -- dist
```

`npm test` runs `js/tests/business-logic.test.js` (room assignment, discounts, registration
window, billing math — dependency-free, plain Node) plus `node --test test/contracts/*.test.js
test/shared/*.test.js`. The `test/shared/*.test.js` suites import the `_shared/*.ts` Edge Function
modules directly (Node 22's native `.ts` execution — this is why the workflow was bumped from
Node 20 on 2026-09-11) and exercise them as pure functions with no network or database. This is
the loop for business-logic changes, `_shared/` changes, and anything in `js/` that doesn't need a
live session.

`npm run build` regenerates `dist/*.min.js` from `js/` via esbuild. Production has no deploy-time
build step — Cloudflare Workers serves the committed `dist/` bundles directly — so a source change
with a stale `dist/` ships nothing. `git diff --exit-code -- dist` (also enforced by
`.github/workflows/auto-merge-claude.yml`) is how you catch that before pushing.

## Loop 2: the Worker, standalone

```sh
npx wrangler dev
```

`worker.js` needs no bindings beyond the committed `assets` directory (`.` — the whole repo root)
to serve every static page. This gets you the HTML/CSS/JS shell and the Worker's own routing
(clean URLs, `/calendar`, `/enroll`) with zero Supabase dependency. It does **not** get you a
working login, clock-in, billing, or anything else that calls into Supabase — the pages will load
but their `js/supabase.js` calls will hit whichever Supabase URL/anon key is baked into the served
files, which by default is the real production project.

## Loop 3: Supabase-side changes (Edge Functions, migrations, RLS)

**There is no separate staging Supabase project today** — despite `CONTRIBUTING.md`'s "apply the
migration in a staging project" guidance, this repository has only ever had the one production
project (`dahdstopsumxnqvdclmy`); see `docs/PROCARE_FEATURE_ANALYSIS.md`'s note that migrations
are applied by hand with no staging environment. Treat that CONTRIBUTING.md language as the
intended process, not a resource that already exists. In practice, verify against the *live*
project (`mcp__Supabase__list_tables`, `list_migrations`, `get_advisors`) before assuming a
migration has been applied — `supabase/migrations/` is a source record, not a live ledger (see
`AGENTS.md`).

Two ways to iterate without touching production:

1. **A Supabase branch** (`mcp__Supabase__create_branch`, or the dashboard) forks the current
   production schema and data into an isolated project you can migrate, break, and test against
   safely, then `merge_branch` or discard. This is the closer-to-real option for RLS/auth/payment
   work, and the nearest thing this repo has to the "staging" `CONTRIBUTING.md` describes.
2. **The Supabase CLI's local stack** (`npx supabase start`) runs Postgres/Auth/Storage/Edge
   Functions in Docker with no project credentials at all. `config.toml` here carries only
   per-function `verify_jwt` overrides (no `[db]`/`[api]` section), so `start` uses CLI defaults.
   There is no bootstrap/seed script that replays all 178 files in `supabase/migrations/` for you
   — apply them in filename order yourself (`supabase/seeds/historical_attendance_2026.sql` is
   fixture data, not schema). This is the right choice for a schema/RLS change you want to develop
   entirely offline before ever touching a real project.

Either way, run an Edge Function locally against whichever target with
`npx supabase functions serve <name> --env-file <your-local-env>`, and confirm `verify_jwt`
posture in `supabase/config.toml` still matches what the function itself expects (a function that
does its own auth, like `family-lookup`, must keep `verify_jwt = false`; see the comments in
`config.toml` for why each override exists).

For schema/RLS/auth changes, `docs/TESTING.md`'s role matrix (full admin, restricted admin,
staff/PIN, parent/own family, other family, anon, unauthenticated) applies regardless of which of
the two options above you used to get a target to test against.

## What you don't need

No local D1/R2/KV — those are `chms`/`website` concepts, not this repo's. No cloud TinyMCE key,
here or on `chms`/`website` — the newsletter's Text block (Messages tab) uses TinyMCE, but it's
self-hosted via `scripts/build.js`'s `vendorAssets()` into `vendor/tinymce/`, loaded with
`license_key: 'gpl'`, never the Tiny Cloud. Run `npm run build` (or `build:watch`) at least once
before opening the Newsletter tool locally, or `vendor/` won't exist yet. Stax webhooks can't be
delivered to a local Worker at all (Stax has no local target); `reconcile-stax-payments` and the
shared unit tests around `stax-transaction-fields.ts` are the practical way to exercise that logic
without a live webhook.
