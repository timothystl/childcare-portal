# Supabase migration drift — audit, 2026-09-14

The **Supabase Preview** check (posted by the Supabase GitHub App, not a workflow in
`.github/workflows/`) fails on every merge commit to `main`:

```
Remote migration versions not found in local migrations directory.
```

It has failed on every merge for months — `bd3d968d` (#391), `b488af92` (#389), the
`claude/nice-gauss-peyk61` auto-merge. On branch commits it reports `skipped`, so it only
surfaces after something lands on `main`.

> ### ⚠️ This check is not a lint. It is a failed write to production.
>
> Corrected 2026-09-14, after the first attempt to silence it did not work. `list_branches`
> on the production project returns exactly one branch:
>
> ```json
> { "name": "main", "git_branch": "main", "is_default": true,
>   "project_ref": "dahdstopsumxnqvdclmy", "parent_project_ref": "dahdstopsumxnqvdclmy",
>   "status": "MIGRATIONS_FAILED", "created_at": "2026-08-17T20:36:37Z" }
> ```
>
> `project_ref` equals `parent_project_ref`, so this "branch" **is the production project**,
> not a preview clone of it. Supabase branching is enabled on it, with `main` as its git
> branch, and its status is `MIGRATIONS_FAILED` — not "check failed".
>
> Reading the evidence: on every push to `main` the integration attempts to apply
> `supabase/migrations/` to the live database, and the version comparison below is where that
> attempt dies. **The red check has been the brake.** It is the reason none of this has ever
> been applied automatically — including the two migrations that are deliberately unapplied.
>
> Not yet confirmed, and worth confirming before anyone acts on it: whether a *passing*
> comparison would go on to apply pending migrations, or merely report success. The status
> value names migrations rather than validation, and Supabase documents the production branch
> as a deploy target, but nobody here has watched it succeed.

This document records what the drift actually is, what was fixed, and what is still open.

## What the message means

The Supabase CLI only recognizes a migration file named `<14-digit-version>_<name>.sql`. It
compares that set against `supabase_migrations.schema_migrations` in the live project and
errors on any remote version with no local file of the same version.

At the time of this audit the live project `dahdstopsumxnqvdclmy` had **151** applied
versions. `supabase/migrations/` had **181** files, of which only **38** carry a 14-digit
prefix the CLI can parse. So the CLI saw 121 remote versions with nothing local to match.

## What the drift is NOT

It is mostly **not** undocumented schema. `docs/DEVELOPMENT.md` already says the quiet part
out loud — this project has no staging, migrations are applied by hand, and
`supabase/migrations/` is "a source record, not a live ledger". The directory was never
maintained as a CLI-managed migration set, so the CLI's naming invariant was never going to
hold. Most of the 121 are the repo's own human-readable filenames
(`throttle_staff_pin_attempts_APPLIED.sql`), not missing work.

Breaking the 151 down against the repo as it stood before this change:

| | count | what it is |
|---|---:|---|
| exact `<version>_<name>.sql` match | 30 | the CLI is happy with these |
| name matches a file with no version prefix | 69 | the repo's own convention |
| name matches a file with a **different** timestamp | 6 | see below |
| the migration's name appears inside another migration | 27 | bundled or superseded; not individually verified |
| its SQL appears verbatim inside another migration | 9 | bundled (`phase1_daily_feed_APPLIED.sql` alone covers six) |
| **absent from the repo entirely** | **10** | **fixed by this change** |

## What was genuinely missing (now fixed)

Ten migrations were live in production with no trace in the repo — not under another name,
not bundled into another file, nothing. They are added here, transcribed from
`supabase_migrations.schema_migrations` and verified byte-identical to what production ran
(normalized-whitespace md5 compared against the live rows):

| version | name | why it matters |
|---|---|---|
| 20260811194724 | `staff_time_off_weekday_weekdays_only` | narrows `staff_time_off_weekday_range` from 0..6 to 0..4. The repo showed only the **old** constraint, so replaying it would have recreated a rule production no longer has. |
| 20260812190719 | `phase1_parent_reads_own_children` | the `parent read own children` policy on `students`, and `set_photo_release()`. |
| 20260813013655 | `fix_parent_registration_submit` | the outage fix that made parent care-day submission work at all (`submit_registration()`). |
| 20260813025705 | `student_allergies_reviewed_stamp` | `students.allergies_reviewed_at` — the column that stops the staff safety panel showing a false all-clear. |
| 20260813025725 | `list_room_children_expose_allergy_review` | surfaces that stamp to the staff app. |
| 20260813031327 | `parent_confirms_child_allergies` | `confirm_child_allergies()` and `students.allergies_source`. A parent-facing RPC writing a **child safety record**, with zero mention anywhere in the repo. |
| 20260813041830 | `confirm_child_allergies_return_source` | returns the provenance alongside the stamp. |
| 20260813214354 | `parent_account_tab` | creates the whole **`pickup_contacts`** table — who is allowed to collect a child — plus `my_account()`, `update_my_phone()`, `set_my_notification_prefs()`, `add_pickup_contact()`, `remove_pickup_contact()`, and `families.notification_prefs`. |
| 20260816032659 | `center_headcount_admin_fix_attendance_join` | the `attendance_records` name-join fix in `center_headcount_rows()`. |
| 20260819212850 | `phase0_sx1_sx9_sx11_grants_and_hygiene` | revokes the default anon/authenticated grant (TRUNCATE included) on `admin_push_subscriptions`, pins `prevent_duplicate_care_date()`'s search_path, moves `pg_trgm` out of `public`. |

Two of these are the reason this was worth doing at all: `pickup_contacts` governs who may
take a child out of the building, and `confirm_child_allergies` writes allergy data. Neither
was reconstructable from the repo.

Adding these files does not change production. They are already applied; this is the record
catching up with the database.

## Known, deliberate, and left alone

**Six files whose timestamp disagrees with the applied-at version.** The file was authored
with a hand-picked timestamp and production recorded a different one:

| remote version | repo file |
|---|---|
| 20260825223846 | `20260825040000_billing_invoice_integrity.sql` |
| 20260910130650 | `20260910000000_fix_record_pin_attempt_duplicate_overload.sql` |
| 20260910183635 | `20260910190000_add_stax_pilot_gate.sql` |
| 20260911211859 | `20260911150000_stax_credit_guard_excludes_imported_history.sql` |
| 20260912140803 | `20260912150000_track_stax_transaction_fee_and_funding_method.sql` |
| 20260913150343 | `20260913120000_parent_schedule_invoice_fee_breakdown.sql` |

Not renamed: `js/admin/admin-finance-hub.js` and `js/tests/business-logic.test.js` cite two of
them by filename, and renaming would spread churn across JS and tests without getting the
check any closer to green.

**Two local migrations not applied, correctly.** `20260913160000_purge_client_error_log.sql`
and `20260914120000_add_calendar_reminder_tracking.sql`. The first is explicitly "prepared
(not scheduled)" — see the `[functions.purge-client-error-log]` comment in
`supabase/config.toml`. Both being local-only is the intended state, not drift.

## The decision — attempted 2026-09-14, and what it missed

Adding the ten files did not turn the check green; 111 remote versions still have no matching
local filename, and the merge commit `29150954` went red again with the same message.

**Andrew then turned off a migration-check setting — option B below — and it did not stop
it.** The next merge, `b1b44081`, failed identically. Whatever that toggle governs, it is not
this: the per-PR preview-branch setting was *already* off before the change (which is why
branch heads have always reported `skipped`), and the thing still firing is the branching
integration's **production branch**, described in the box at the top of this document.

So option B as executed did not land. What it would actually take is disabling branching for
the project, or disconnecting the GitHub integration, or repointing its production branch at
something that never receives commits — and per the box above, **that should not be done
until someone has established what the integration would do on a passing run**, because right
now the failure is the only thing standing between `main` and an automatic migration apply.

The options are kept below so the reasoning survives.

What holds either way:

- `supabase/migrations/` stays what `docs/DEVELOPMENT.md` already called it: **a source
  record, not a live ledger**. It is not CLI-managed and `supabase db push` is not the
  deployment path.
- Whenever this check does get silenced, **the gap this audit found can silently reopen.** A
  migration applied by hand and not committed would leave no trace and no red check.
  Committing the file is then the only safeguard.
- Re-running the audit is cheap and worth doing periodically: compare
  `mcp__Supabase__list_migrations` against `supabase/migrations/`, and for anything with no
  local file, check `supabase_migrations.schema_migrations` for its statements. That is how
  the ten above were found.

### The options, and what each cost

**A. Adopt the CLI convention.** Rename or split ~111 files so every remote version has a
`<version>_<name>.sql`. Repo-only, no production write. But: the bundles do not map 1:1
(`phase1_daily_feed_APPLIED.sql` covers six remote versions, `staff_injury_and_headcount.sql`
three), so this is judgment-heavy splitting, not a `git mv` script — and doing it badly
produces a directory that *claims* to be replayable and isn't, which is worse than an honest
mess. It also has a specific hazard, and the box at the top of this document upgrades that
hazard from conditional to near-certain: once the CLI can see a complete history, the two
deliberately-unapplied migrations above become the only pending ones, and the integration
already tries to apply migrations to production on every push to `main`. **Making the
directory valid could therefore schedule the `purge-client-error-log` cron job in production
as a side effect of a merge.** Nobody should start down this path until the integration is
either disconnected or understood.

**B. Stop the integration checking migrations. ← attempted, did not take.** Stops the noise. Costs the option of ever using `supabase db push` without doing (A) first.
Given `docs/DEVELOPMENT.md` already documents hand-application as the real process, this is
the option that matches how the project actually works.

The control is in the Supabase dashboard under **Project Integrations Settings** — the same
screen the check itself points at. Its own output on a PR head reads:

> Creating a new preview branch per PR is disabled. You can re-enable it in Project
> Integrations Settings.

which is why the check reports `skipped` on branches and only fails once something reaches
`main`: with preview branches off, the only thing it still does on `main` is compare the
migration directory against production's history — the comparison that has never been able
to pass here.

**C. `supabase migration repair`.** Rewrites the live project's migration-history table.
This is a production write and per `AGENTS.md` needs Andrew's explicit approval for that
operation. It is also the wrong tool here: these migrations really were applied, and marking
them reverted would make the history less true, not more.

**B was attempted and did not take; see the correction above.** A remains available as part of
the "code normalized" overhaul work, where splitting the bundles can be done deliberately
with the deploy posture established first — and where turning the check back on, meaning it,
would be the point of doing it.
