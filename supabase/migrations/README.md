# Migrations

## The one rule

**Never invent a timestamp.** Apply the migration first, ask the database what
version it recorded, and name the file *that*.

The Supabase dashboard, the CLI and the MCP `apply_migration` tool each stamp
their own version from the clock at the moment the SQL runs. If you write the
file first with a timestamp you chose, the database records a different number
and the two never reconcile.

That is not hypothetical. It is what happened here:

| Committed as | Recorded by the database as |
|---|---|
| `20260915120000_track_stax_card_funding_type.sql` | `20260915002107` |
| `20260915130000_stax_processor_fee_backfill.sql` | `20260915002122` |
| `20260914120000_add_calendar_reminder_tracking.sql` | `20260914193728` |

Nothing complained at the time. It surfaced months later as
`Remote migration versions not found in local migrations directory` on the
Supabase Preview check — failing every commit to `main` until the failure was
just background noise nobody read. By then 114 versions had drifted, and a
migration that genuinely never ran (`purge_client_error_log`) was hiding in
the noise, its 90-day retention promise quietly unkept.

## The workflow

```bash
# 1. Apply it — dashboard, CLI, or MCP. All three stamp their own version.
# 2. Ask the database what it actually recorded:
#      select version, name from supabase_migrations.schema_migrations
#       order by version desc limit 5;
# 3. Name the file with THAT version:
#      supabase/migrations/<version>_<name>.sql
# 4. Refresh the committed snapshot and check:
npm run migrations:snapshot < rows.tsv
npm run migrations:check
```

`npm run migrations:check` also runs as part of `npm test`, so drift is caught
in the pull request that causes it rather than a quarter later. It needs no
database access — it diffs the filenames against `APPLIED_LEDGER.tsv`, the
committed snapshot of what production actually has.

## What the filenames mean

| Shape | Meaning |
|---|---|
| `<14-digit version>_<name>.sql` | Part of the applied sequence. Its version **must** appear in `APPLIED_LEDGER.tsv`. |
| `PROPOSED_*.sql` | A proposal. Not applied, not approved, deliberately un-versioned so nothing runs it. |
| `ROLLBACK_*.sql` | How to undo a specific migration. Run by hand, never in sequence. |
| `VERIFY_*.sql` | Read-only checks you run after applying something. |
| `HISTORICAL_*.sql` | Applied, but never recorded under its own version — either before the ledger existed, or bundled inside another version's SQL. Kept as the written record. Never replayed. |

A file with no version prefix and no recognized prefix is a bug, and
`migrations:check` fails on it. A version prefix is what makes the CLI try to
*run* a file, so anything that must not run keeps a word prefix instead.

## Ledger placeholders

Some versioned files in this folder contain no statements at all, only a header
saying so. Those are versions production applied whose SQL was never committed
under that version number. The placeholder records that the version exists and
points at where its DDL actually lives — or says plainly that it lives nowhere
in this repository and the live schema is the only record.

They exist because inventing SQL to match a schema nobody captured would be
worse than the gap: a rebuild would then differ from production *silently*
instead of loudly.

## ⚠️ This folder is not a rebuild source

It has not been one since before the ledger started. Files were applied by hand
through the SQL Editor, bundled several-versions-to-a-file, and in some cases
never written down at all. To reproduce this database, restore a backup — do
not replay this folder.

## Applying anything at all

Per `AGENTS.md`: migrations here are **not** applied automatically, and schema,
RLS, auth, payments, scheduled jobs, data ownership and deployment changes need
Andrew's explicit approval for that specific operation. This is a live
childcare and payment system holding real family, child, staff, attendance,
wage and billing data.
