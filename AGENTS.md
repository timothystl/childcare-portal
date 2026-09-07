# Timothy myMDO — Agent Instructions

This is the only AI startup instruction file for this repository. Claude reads it through
`CLAUDE.md`; Codex reads it directly. Do not preload or survey other Markdown files. Open a
manual, runbook, review, or plan only when the present task specifically requires it, and
verify dated claims against source, tests, Supabase, GitHub, and live behavior.

## Product boundary

This repository is the complete myMDO product: public childcare information and registration,
families, parent portal, classrooms, staff operations, clock-in, schedules, billing, payments,
messages, and MDO payroll inputs/approval. Do not split out a separate MDO HR product or bolt
general MDO content into the Church Website page editor.

Production consists of Cloudflare Worker `childcare-portal` serving repository assets and
Supabase project `dahdstopsumxnqvdclmy` for database, Auth, Storage, Edge Functions, and scheduled
jobs. The public hostname is `mdo.timothystl.org`. The repository may eventually be renamed
`mymdo`, but only as a dedicated non-functional change after higher-risk architecture work.

## Safety rules

- This is a live childcare and payment system containing real family, child, staff, attendance,
  wage, billing, and payment data. Treat correctness, privacy, and recoverability as release gates.
- Never expose credentials, PINs, tokens, family/child data, staff records, wages, or payment data.
- The Supabase anon/publishable key is public by design; the service-role key and every private
  integration credential must exist only in managed secrets.
- UI hiding is not authorization. Enforce ownership and role checks in RLS, RPCs, Edge Functions,
  or the Worker as appropriate. Parent and staff PIN paths must rate-limit and fail closed.
- Never trust client-supplied family, staff, amount, recipient, or authorization claims when the
  server can derive or re-read them.
- Migrations in `supabase/migrations/` are not automatically applied. Verify live schema state
  before deploying code that depends on a migration. Stage and smoke-test auth, billing, payment,
  and RLS changes before production.
- Do not change production, schema, RLS, auth, payments, scheduled jobs, data ownership, or
  deployment configuration without Andrew's explicit approval for that operation.
- Preserve unrelated work. Do not reset, rebase, force-push, or overwrite shared history.

## Payments

- Stax is the current payment integration. Authorize.net was retired by migration
  `20260830211423_retire_authorizenet_processor.sql`; do not revive its paths accidentally.
- The browser never determines the amount charged or the authoritative payment result.
- Webhooks must authenticate, re-fetch the provider transaction, remain idempotent, and reconcile
  charge/refund/void state without duplicating ledger effects.
- Payment changes require focused tests plus live-safe reconciliation and rollback planning.

## Source and build rules

- Edit source under `js/`; `dist/*.min.js` is generated and committed because production serves
  it directly. After source changes, run `npm run build` and commit the matching `dist/` output.
- `worker.js` is the Cloudflare entry point; `wrangler.jsonc` defines the Worker and asset routing.
- `supabase/config.toml` documents Edge Function JWT gateway posture. Functions with
  `verify_jwt = false` must perform their own explicit authentication/authorization.
- Keep duplicated server/client room configuration synchronized; the business-logic suite has
  drift guards for intentional copies.

## Tests and release behavior

Use Node 20 for the existing workflow:

```bash
npm ci
npm test
npm run build
git diff --exit-code -- dist
```

Run focused browser and Supabase/RLS verification appropriate to the changed surface. Do not call
a test green unless it exercises the real changed path and fails on the prior regression.

Pushing a `claude/**` branch currently triggers tests, merges it automatically into `main`, and
deploys production. Therefore, never use a `claude/**` branch for tentative work. Use an ordinary
review branch and PR. Merging to `main` is a production release and requires explicit approval.

## Timothy Digital overhaul checkpoint

- myMDO remains one product and repository during the current preparation work.
- Preparation 3 backup/restore and Preparation 6 documentation reset are in progress at the
  cross-product level. No myMDO repository rename, shared-auth rollout, data move, or payroll
  cutover is authorized by that status.
- Finance may consume narrow approved summaries from myMDO; it does not own raw childcare billing,
  clocks, schedules, or family records.

## Documentation discipline

`CLAUDE.md` only imports this file. `README.md`, `CONTRIBUTING.md`, security reviews, feature plans,
go-live notes, and role manuals are task-specific human/reference documents—not startup
instructions or parallel sources of current truth. The old setup-oriented README must never be
used to recreate obsolete permissive RLS or client-side password patterns. Preserve manuals and
legal/reference material, but verify them against the live app before relying on them. Keep durable
rules here, tasks in the issue tracker, and implementation history in Git. Keep this file below
200 lines and update it when architecture or release behavior materially changes.
