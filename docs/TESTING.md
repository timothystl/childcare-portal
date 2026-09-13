# Testing

Use Node 22 (bumped from 20 on 2026-09-11 — `test/shared/*.test.js` uses native `.ts` execution,
which Node 20 doesn't support; see `AGENTS.md`):

```sh
npm ci
npm test
npm run build
git diff --exit-code -- dist
```

Generated `dist/*.min.js` must match `js/` because production serves the committed bundles without
a deploy-time build. Add focused browser and Supabase/RLS verification for the changed path.

For schema or policy changes, verify the intended target and migration order, then test positive
and negative roles: full admin, restricted admin, staff/PIN, parent/own family, other family, anon,
and unauthenticated as applicable. Payment changes additionally require idempotency, amount,
provider-state, webhook, reversal, and safe failure-path checks.

A green local suite does not establish that a migration/function was deployed, a live policy is
correct, a payment reconciled, or a backup restored. Record those as separate evidence.
