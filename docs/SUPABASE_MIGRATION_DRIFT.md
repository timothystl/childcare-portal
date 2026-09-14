# Supabase migration drift — audit, 2026-09-14

The **Supabase Preview** check (posted by the Supabase GitHub App, not a workflow in
`.github/workflows/`) fails on every merge commit to `main`:

```
Remote migration versions not found in local migrations directory.
```

It has failed on every merge for months — `bd3d968d` (#391), `b488af92` (#389), the
`claude/nice-gauss-peyk61` auto-merge. On branch commits it reports `skipped`, so it only
surfaces after something lands on `main`. A check that is always red is a check nobody reads,
which is its own risk: a real migration problem would land unnoticed.

This document records what the drift actually is, what was fixed, and what is left to decide.

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

## What is left to decide — needs Andrew

Adding the ten files does not turn the check green; 111 remote versions still have no
matching local filename. Getting to green means picking a workflow, and each option has a
real cost:

**A. Adopt the CLI convention.** Rename or split ~111 files so every remote version has a
`<version>_<name>.sql`. Repo-only, no production write. But: the bundles do not map 1:1
(`phase1_daily_feed_APPLIED.sql` covers six remote versions, `staff_injury_and_headcount.sql`
three), so this is judgment-heavy splitting, not a `git mv` script — and doing it badly
produces a directory that *claims* to be replayable and isn't, which is worse than an honest
mess. It also has a specific hazard: once the CLI can see a complete history, the two
deliberately-unapplied migrations above become the only pending ones. **If the Supabase
GitHub integration is configured to push on `main`, that would schedule the
`purge-client-error-log` cron job in production as a side effect.** That configuration lives
in the Supabase dashboard, not this repo, and must be checked before anyone starts down this
path.

**B. Stop the integration checking migrations.** Turn off the migration check in the Supabase
dashboard's GitHub integration settings. Zero production risk, and it stops the check lying.
Costs the option of ever using `supabase db push` without doing (A) first. Given
`docs/DEVELOPMENT.md` already documents hand-application as the real process, this is the
option that matches how the project actually works.

**C. `supabase migration repair`.** Rewrites the live project's migration-history table.
This is a production write and per `AGENTS.md` needs Andrew's explicit approval for that
operation. It is also the wrong tool here: these migrations really were applied, and marking
them reverted would make the history less true, not more.

**Recommendation: B now, A only as part of the "code normalized" overhaul work**, where
splitting the bundles can be done deliberately with the deploy posture checked first.
