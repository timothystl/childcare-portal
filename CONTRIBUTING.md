# Contributing — branch & deploy hygiene

Two real incidents (2026-06-05) motivated these rules. Follow them to avoid
repeating them.

## 1. Rebase feature branches on `main` before merging
**Why:** a feature branch (`charming-meitner`) carried a stale `js/supabase.js`
and, when auto-merged, silently **reverted a line** (`has_staff_pin` in the staff
query) that another branch had added — blanking the admin PIN column in
production.

**Rule:**
- Before merging, `git fetch origin main` and `git rebase origin/main` (or merge
  `main` in). Resolve conflicts deliberately — never let an older copy of a
  shared file (`js/supabase.js`, `js/admin/*.js`) win by default.
- Two branches editing the same shared file at once is a smell. Coordinate or
  land them sequentially.
- After merging, sanity-check shared files: e.g.
  `grep -n "has_staff_pin" js/supabase.js` should still match.

## 2. Apply DB migrations BEFORE deploying code that depends on them
**Why:** `hash_staff_pins.sql` was committed but never applied to the database,
while the deployed kiosk already called the `lookup_staff_by_pin` RPC and the
`staff_pin_hash` column — so clock-in broke with "function/column does not exist."

**Rule:**
- `supabase/migrations/` is **not** auto-applied — migrations are run by hand in
  the Supabase SQL Editor. A committed migration is NOT a deployed migration.
- Before deploying frontend that uses a new RPC/column/table, confirm it exists:
  ```sql
  SELECT proname FROM pg_proc WHERE proname = '<fn>';
  SELECT column_name FROM information_schema.columns
   WHERE table_name = '<table>' AND column_name = '<col>';
  ```
- For auth/billing/RLS changes: apply the migration in a **staging** project,
  smoke-test (parent login, clock-in kiosk, a test registration, admin tabs),
  then prod. Never push the dependent JS first.

## 3. Versioning
Run `npm run bump` before each PR (updates `package.json` **and**
`js/build-version.js` together). The admin header shows the live build version —
use it to confirm a deploy actually shipped.

## 4. Sequenced/staged migrations
Some migrations must be paired with a deploy in a specific order (e.g. the
SS2 family-login PIN change). When that's the case, the migration file's header
states the order. Read it before applying.
