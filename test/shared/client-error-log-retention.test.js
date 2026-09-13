// This repo has no pgTAP/pg_prove harness for exercising migration SQL
// against a live database in CI (see test/contracts/mymdo-finance-summary.test.js
// for the closest existing precedent: asserting on file content rather than
// executing it). Short of that, this test statically asserts the invariants
// that matter most for a purge migration: the retention window is the
// documented 90 days (not silently drifted by a future edit), the function is
// SECURITY DEFINER so the Edge Function's `authenticated` role can call it
// without table-level DELETE, and it is revoked from PUBLIC/anon — the same
// role boundary sweep_expired_child_photos() uses, and one this table
// specifically needs given its public-insert policy.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const migrationPath = path.resolve(
  __dirname, '../../supabase/migrations/20260913160000_purge_client_error_log.sql',
)
const sql = fs.readFileSync(migrationPath, 'utf8')

test('purge_client_error_log migration', async (t) => {
  await t.test('deletes from client_error_log, not some other table', () => {
    assert.match(sql, /DELETE FROM client_error_log\b/)
  })

  await t.test('retention window is the documented 90 days', () => {
    assert.match(sql, /occurred_at < now\(\) - interval '90 days'/)
  })

  await t.test('filters on occurred_at, not id or another column that would not express a time window', () => {
    const deleteClause = sql.match(/DELETE FROM client_error_log\s+WHERE ([^\n]+)/)
    assert.ok(deleteClause, 'expected a WHERE clause on the DELETE')
    assert.match(deleteClause[1], /^occurred_at </)
  })

  await t.test('function is SECURITY DEFINER (the Edge Function calls it as authenticated, not with table DELETE)', () => {
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.purge_client_error_log\(\)[\s\S]*?SECURITY DEFINER/)
  })

  await t.test('EXECUTE is revoked from PUBLIC and anon', () => {
    assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.purge_client_error_log\(\) FROM PUBLIC, anon;/)
  })

  await t.test('EXECUTE is granted to authenticated only (no anon grant anywhere in the file)', () => {
    assert.match(sql, /GRANT\s+EXECUTE ON FUNCTION public\.purge_client_error_log\(\) TO authenticated;/)
    assert.equal(/GRANT[^;]*\banon\b/i.test(sql), false)
  })

  await t.test('returns a count (bigint) so a caller can report how many rows were purged', () => {
    assert.match(sql, /RETURNS bigint/)
    assert.match(sql, /SELECT count\(\*\) FROM deleted/)
  })

  await t.test('does not itself schedule anything — no live cron.schedule call in this migration', () => {
    // Strip `--` line comments first: the migration's header prose mentions
    // cron.schedule() by name (explaining what was left commented out and
    // what the PR's follow-up would add), which must not be confused with an
    // actual executable statement in this file.
    const withoutComments = sql.replace(/--[^\n]*/g, '')
    assert.equal(/cron\.schedule/.test(withoutComments), false)
  })
})
