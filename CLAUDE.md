# Childcare Portal — Claude Code Guide

## Git branch naming

Always use descriptive branch names in the format `type/short-description` (e.g. `fix/billing-change-fees`, `feat/add-goose-room`, `chore/update-deps`). Never use auto-generated random names.

---

## PR workflow

`.github/workflows/auto-merge-claude.yml` auto-merges any push to a `claude/**` branch straight into `main` (and deploys) — no human action required, no draft PR needed to unblock the merge. When working in a cloud session (feature branch required by session config), push your work, then still open the PR via the GitHub MCP tool for visibility/history — by the time it's created, CI will typically have already merged the branch into `main`, so the PR will show as merged automatically. Don't wait on or babysit a PR here expecting it to need manual merging; if CI hasn't picked it up yet, that's a CI issue to flag, not something to leave sitting as a draft for the user to click a button on.

---

## Version numbering

The app version uses **semantic versioning** (`major.minor.patch`) stored in `package.json`.

**For every PR, run `npm run bump` before committing.** This script increments the patch version in both `package.json` and `js/build-version.js` atomically — never edit either file by hand.

```bash
npm run bump          # patch: 1.13.2 → 1.13.3
```

`js/build-version.js` is what the live site actually reads (bundled or not), so both files must stay in sync. The `bump` script guarantees that.

For minor or major bumps (new features, breaking changes), edit `package.json` manually first, then run `npm run bump` to sync `js/build-version.js`, or just edit the version number in both files together.

| Change type | When to use |
|---|---|
| `patch` | Bug fixes, small tweaks (use `npm run bump`) |
| `minor` | New features, meaningful additions |
| `major` | Radical redesigns, breaking changes (reserved for 2.0.0) |

**End every coding-task response (in this repo or any other) with the resulting version number** (e.g. "Current version: v1.17.6") so it's always clear what's live after a change.

---

## Project overview

Timothy Lutheran MDO (Mother's Day Out) registration portal. Parents register children for monthly care days; admins manage scheduling, billing, payroll, and the waitlist.

**Stack:** Vanilla JS (no framework) · Supabase (PostgreSQL + Auth + Storage) · Cloudflare Pages/Workers · esbuild for bundling.

---

## Admin portal shell (v2.5.0 — the "myMDO Admin Portal" redesign)

`admin.html` no longer navigates by tab-pane. `js/admin/admin-portal.js` owns
navigation. **Two levels, no modes** (this replaced a first cut that shipped a
Dashboard/List/Rail layout toggle — asking the director to pick a presentation
of the menu before picking a tool was a decision the product should not have
put to her):

1. **Dashboard** — the landing state for every tab. Metrics, panels, attention
   list, and contextual tool pills next to the numbers that motivate them.
2. **Detail** — a tool is open. The sidebar stays put and highlights where you
   are, so there is no back link.

`#apNav` is a **permanent left sidebar**: seven tabs, then the active tab's
tool groups. Below 900px it collapses into the hamburger drawer, which renders
the same content; above 900px the hamburger is hidden entirely.

Seven role tabs: **Director · Classrooms · Staff · Finance · Planning ·
Market Analysis · Settings**. Every existing `.admin-section` /
`.table-section` / `.capacity-section` is one entry in `AP_TOOLS` (key →
`section` id + `pane`); the shell shows exactly one at a time by putting
`.ap-hidden-tool` on the rest. **Adding a section to `admin.html` means adding
an `AP_TOOLS` entry, or it is unreachable.**

- **Director owns no tools.** It is a dashboard; its sidebar entry expands to a
  one-line explanation. Every link on it deep-links to the tool under its real
  home tab (`apGo()` sets `apState.tab` to `tool.tab`), so the sidebar reveals
  where the thing actually lives instead of maintaining a parallel index.
- `setupTabs()` (admin-settings.js) keeps only the drawer open/close wiring and
  then hands off to `setupAdminPortal()`. The old `activate(tab)` path is dead.
- Role restrictions still hide sections with inline `display:none`;
  `apToolAvailable()` reads that, plus `AP_FULL_ONLY_TABS` (finance, market)
  and `AP_FULL_ONLY_KEYS` (payroll — it sits under Staff but is still pay
  data). `staff` role sees Classrooms only. `applySessionRole()` re-renders.
- Only `apTab` and `apDone` persist. `apLayout` is removed on load.
- The section's own `<h2>` is hidden while its tool is open (the shell renders
  the name above the card) **unless the heading contains a control** — Care
  Calendar's "New Registration" button lives inside its `<h2>`.
- New tools built in this module rather than mapped: **Daily Staffing
  Requirement** (`#staffReqSection`) and **Rate Increase Scenarios**
  (`#rateScenarioSection`). Both compute from booked registrations only —
  clock-in room data is deliberately never read.
- **Invoices** (`#invoicesSection`, rendered by `renderInvoicesTool()` in
  admin-billing.js) is the middle of the money flow, which was missing: the
  portal could compute a bill and record a payment but never *issue* one, so
  all 496 rows in `billing_invoices` sat at `status='draft'` forever. It
  computes nothing new — `_buildFamilyBillingData()` stays the single source of
  truth — and adds draft → issue over it.
  - `add_invoice_send_stamp.sql` (**applied 2026-08-11**) adds `sent_at` /
    `sent_to`. Accounts Receivable should age overdue from `sent_at`, not from
    the start of the month.
  - **`send-invoice` edge function** (deployed 2026-08-11) does the sending.
    Two buttons: *Email invoices* (sends + stamps) and *Mark sent (no email)*
    for bills issued another way. Both stamp `sent_at` and write to the audit
    log, so AR ages correctly either way.
    - **Its security posture is the one to copy, not the older functions'.**
      The request body carries **only invoice ids** — recipient, family name
      and every figure are read server-side with the service role, so it
      cannot be aimed at an arbitrary address the way T1/FS6/FS11 describe.
      It also requires a `full` admin role, not merely a session, and stamps
      `sent_at` only *after* Resend accepts the message.
    - Already-sent invoices are skipped unless `resend: true`, so re-clicking
      cannot double-send. Batch capped at 200.
    - Needs `RESEND_API_KEY` / `RESEND_FROM_EMAIL` / `RESEND_REPLY_TO`
      secrets (shared with the other email functions). Without the API key it
      returns 500 rather than pretending to send.
    - The "how to pay" line comes from the `invoice_email_note` setting,
      editable in the tool. ⚠️ `settings.value` is a **text** column, so it
      arrives at the function as a string even when it holds JSON — `readNote()`
      handles bare string / JSON string / `{text}`. This is the T3 trap; do not
      assume a parsed object.
- **Time off**: staff request days off at the kiosk → the request lands pending
  in the director's "Needs your OK" panel inside Build Staff Schedule →
  approving is what makes it real. Only `approved` rows reach
  `autoFillStaffSchedule()` (via `window.apApprovedOffForWeek`). Table + the two
  PIN-gated definer RPCs are in `supabase/migrations/add_staff_time_off_requests.sql`,
  **applied and verified in production 2026-08-11**.
  - ⚠️ **`staff.id` is `uuid`**, as is `staff_id` on `staff_clock_events`,
    `staff_hours` and `staff_schedules`. The first draft of this migration
    assumed `bigint` and failed with `42804`. Never coerce a staff id with
    `Number()`/`parseInt()` — `staff_time_off_requests.id` is a bigserial but
    `staff_id` is not.
  - `weekday` is `0=Mon … 4=Fri` and is **constrained to 0..4** — the center is
    closed at weekends and the admin UI indexes a five-entry day array.
  - Verified live: `anon` has no SELECT/INSERT on the table and cannot reach it
    except through the two RPCs (both `SECURITY DEFINER`, `search_path` pinned,
    bcrypt-verifying the PIN); a bad PIN returns `NULL` rather than erroring;
    a full submit → list → store round trip works and stamps the right weekday.

---

## ⚠️ Current open queue — start here (updated 2026-08-03, v2.3.23)

A fifth sweep (whole codebase + **live production verification**) was done 2026-08-02,
with remediation continuing 2026-08-03.
Findings R1–R27 with full write-ups and a staged remediation order live in
**`docs/CODE_REVIEW_2026-08.md`**. That file supersedes the per-sweep history below
for anything still open.

**Exposure check (2026-08-03):** `pg_stat_statements` is complete since 2026-03-10
with **zero evictions**, and the bcrypt migrations appear in it — so it covers the
entire lifetime of the hash columns. **Zero** API queries have ever read
`families.pin_hash`, `families.parent2_pin_hash` or `staff.staff_pin_hash`, and there
has never been a `select *` on `families`. No evidence the hashes were accessed. This
does **not** clear R1: the app legitimately reads names/emails, so a harvester would
have used an identical query shape and be invisible.

**Fixed and verified in production 2026-08-11:**
- **FS5 Phase 1** — `add_day_to_invoice_by_email` was `SECURITY DEFINER` and executable
  by **both `anon` and PUBLIC**, took its delta verbatim with **no clamp**, and had **no
  status guard**. A negative delta could therefore be pushed at an invoice in *any*
  status — including `finalized` and `paid` — so the public anon key could set any
  family's settled invoice to any value, including zero. Strictly worse than FS5 as
  written. `fs5_phase1_revoke_add_day_anon.sql` applied: revoked from `PUBLIC` **and**
  `anon` (revoking `anon` alone is insufficient — the `=X/postgres` PUBLIC grant is
  inherited, same trap as R26/R27), and the delta is clamped `>= 0`. Safe because
  `pg_stat_statements` shows **30 calls, all `authenticated`, zero anon calls ever**;
  the only caller is the admin Add-a-Day modal (`js/admin/admin-calendar.js`).
  Verified post-apply: `has_function_privilege` anon=false, authenticated=true.
  **Rollback:** `ROLLBACK_fs5_phase1_revoke_add_day_anon.sql`.
- **FS5 Phase 2** — `create_billing_invoice_by_email` took the invoice amount **from the
  browser**, and `p_email` chose whose invoice to write, so the public anon key could
  inflate any family's draft. `fs5_phase2_server_side_invoice_amount.sql` applied:
  `p_amount` is ignored and the family's whole month is recomputed in the database by
  `compute_family_month_charges()` (registration_dates × room rates × individual and
  sibling discounts × change fees, waitlisted days excluded). Verified post-apply by
  **injection test** — passing `999999` stored `1455.00`. The old 3-arg signature is
  kept as a shim that ignores the amount, so deploy order doesn't matter.
  Because it recomputes the whole month the upsert **SETs rather than ADDs**, which is
  idempotent and supersedes FS3's additive semantics (FS3's clamp and draft-only guard
  are retained). **Prerequisite for attaching any payment processor — now met.**

  ⚠️ **`compute_family_month_charges()` mirrors `buildBillingBreakdown()` /
  `getChildDayAmounts()` / `effectiveRate()` in `js/app.js`.** It is exact against the
  current rate config only because every room has `weeklyFullRate`/`weeklyHalfRate`
  `NULL`. **Setting a weekly rate in Settings → Rates requires implementing the weekly
  branch in that SQL function too**, or the draft and the generated invoice will disagree.

- **Billing writes are now recompute-only (2026-08-11).** Seven admin paths can change a
  child's days; only two used to tell billing anything, and Add-a-Day used a *delta*
  while all four removal/edit paths did nothing at all — so invoices could only ratchet
  upward. Every path now calls `_recomputeInvoice()` in `js/admin/admin-calendar.js`.
  `addDayToInvoiceByEmail()` is deleted; the DB function `add_day_to_invoice_by_email`
  is unused and can be dropped. **Never add a delta-based billing write — a delta
  requires every mutation site to opt in, which is exactly how this drifted.**

**Fixed and verified in production 2026-08-03:**
- **R26** — `anon` could read `staff.staff_pin_hash`, `hourly_rate`, `salary_biweekly`
  and `pto_starting_balance` (staff wages + PIN hashes) via the public key. Same class
  as R3, missed because R3 was scoped to `families`. Narrowed to display columns in
  `phase1_narrow_anon_staff_columns.sql`. Verified no anon path reads the table (the
  kiosk uses the `lookup_staff_by_pin` SECURITY DEFINER RPC); smoke-tested the kiosk
  RPC as `anon` and the admin roster as `authenticated` after applying.

**Fixed and verified in production 2026-08-02:**
- **R2** — `set_family_pin` / `set_staff_pin` were anon-executable `SECURITY DEFINER`
  with no auth and no old-PIN check (total account takeover in two calls).
  `EXECUTE` revoked from `anon`/`PUBLIC`; `authenticated` retains it.
- **R3** — `pin_hash` / `parent2_pin_hash` were readable via the public anon key.
  anon's table-level SELECT on `families` replaced with an explicit column grant
  that excludes both. Verified: anon now gets `permission denied` on either column.

**Fixed and verified in production 2026-08-03 (continued):**
- **R5** — the admin audit log now **exists and records**. `add_audit_log_hardened.sql`
  applied (the committed `add_audit_log.sql` is marked SUPERSEDED — it would have made
  the log anon-readable via a non-`security_invoker` view + Supabase default grants).
  `authenticated` has SELECT only, so entries can't be edited or deleted from the client.
  Also fixed `logAdminAction()`: supabase-js `.rpc()` *resolves* with `{data,error}`
  rather than throwing, so the old try/catch never inspected the failure at all.
- **R27** — `anon` could **read every parent contact message** (name/email/body) and
  could **INSERT closures and settings**. Revoked in `phase1_revoke_unused_anon_verbs.sql`.
  `waitlist_applications` deliberately untouched — see below.

**Needs a human / live site (can't be settled from code or catalog):**
- `submitWaitlistApplication()` chains `.insert().select()`, but anon has **no SELECT
  policy** on `waitlist_applications` and RLS applies SELECT policies to `RETURNING`.
  Either the public waitlist form is failing today or something else carries it. Last
  application is 2026-07-11. **Submit a test application through the public form to settle.**

**Fixed and verified in production 2026-08-11:**
- **R1 / R4 — `families` and `students` closed.** `r1r4_phase1_families_students.sql`
  applied. The five anon policies (`select`/`update` on `families`; `select`/`update`/
  `delete` on `students`) are dropped and `DELETE, UPDATE, TRUNCATE` revoked from `anon`
  on both tables. Verified live: the only anon policy left on either is `anon insert`.
  Safe because `family_login` is SECURITY DEFINER (the parent portal reads children from
  its payload, never from the tables), `pg_stat_statements` showed ~22 anon calls to the
  two tables out of 80,992, and PIN reset bypasses anon RLS entirely.
  **Rollback:** `ROLLBACK_r1r4_phase1_families_students.sql`.

  ⚠️ The ⛔ header on `tighten_anon_rls_policies.sql` claiming `family_login` is
  SECURITY INVOKER is **wrong** — it is and was DEFINER, so the real cause of the
  2026-06-05 login regression is **unknown**. Don't plan around that note.

**Still open and serious — see the review doc:**
- **R1 (remainder)** — `anon` can still read all of `registrations` / `registration_dates`
  (child names, parent emails, full schedules) and `staff`. Both are genuinely
  load-bearing: registrations SELECT drives capacity counts and the duplicate check
  (~5,700 calls). Fix = apply `ss1_public_read_rpcs.sql`, cut the 4 read helpers over,
  then drop the policies.
- **R4 (remainder)** — `anon` holds SELECT/INSERT/**UPDATE** on `staff_clock_events`.
  ⚠️ Contrary to R4's write-up, that UPDATE is **not** safe to drop — it is how the kiosk
  clocks staff **out** (~1,280 calls). Needs a definer RPC keyed on the kiosk session,
  not a policy drop.
- **R24** — the registration window is **not** enforced server-side (see below).
- **R20** — `restricted`/`staff` admin roles are enforced only in the browser.

**Migration reconciliation (2026-08-02, updated 2026-08-03).** All files in
`supabase/migrations/` were diffed against the live catalog. Three were unapplied;
`add_audit_log.sql` has since been superseded and applied as
`add_audit_log_hardened.sql`. Still unapplied: `enforce_registration_window.sql`
(R24), and `ss1_public_read_rpcs.sql` (known staged
groundwork). Everything else is applied, including
`add_staff_time_off_requests.sql` and `add_invoice_send_stamp.sql`
(both 2026-08-11). **Re-run this diff after any migration work — a committed migration
is not a deployed one, and that is exactly how R5 and R24 hid.**

**Updated 2026-08-11:** `add_staff_time_off_requests.sql` was written **and applied**
in the same session (admin portal redesign — the kiosk→director time-off flow).
Verified post-apply: `anon` holds zero table grants and is denied SELECT/INSERT,
RLS is on with a single `authenticated` policy, both RPCs are `SECURITY DEFINER`
with pinned `search_path`, and an end-to-end submit/list round trip through the
`anon` role stores the correct staff uuid and weekday.

`add_attendance_records.sql` was also written **and applied**
in the same session (child attendance capture). Verified post-apply: `anon` holds
zero grants, RLS is on, the only policy is scoped to `authenticated`, and an
`anon` read returns permission denied. The unapplied list above is unchanged.

---

## Project status & outstanding work (older sweeps — updated 2026-07-12)

> **Note:** the section below is historical and drifted. Known stale points: it cites
> `v1.17.6` as a version example (the app is past v2.3); it lists **T2** as open, but
> `js/admin/admin-messages.js` exists and renders the inbox correctly; and it says
> **SS5** is "likely moot" because the billing-by-email RPCs aren't deployed — they
> *are* deployed, as a later paragraph in the same section says. Treat
> `docs/CODE_REVIEW_2026-08.md` as authoritative for open work.

A full code review + a deeper "second sweep" + a "third sweep" + a whole-codebase
"fourth sweep" (2026-07-12) were done. Detailed records live in:
- **`docs/CODE_REVIEW.md`** — all findings, labeled (S/U/V/N/P/Q/C/M for the first
  review; SS1–SS19 for the correctness/integrity sweep; T1–T20 for the third
  sweep; **FS1–FS30 for the fourth sweep**), with `[x]`/`[~]`/`[ ]` status.
- **`docs/NEXT_STEPS.md`** — the prioritized action plan + an incident log.
- **`CONTRIBUTING.md`** — branch/deploy rules (read before merging).

### Done & shipped
- First-review fixes (escaping, focus states, ARIA, design tokens, init/`MONTH_NAMES`/
  `parseJsonOr` dedup, billing dedup, etc.) and several SS items (SS6 month_key query,
  SS7 staff-save button, SS14 recurring-days, SS15 multi-room selector). All on `main`.
- **DB applied in prod:** `hash_staff_pins.sql` (staff PINs now bcrypt-hashed — they had
  never been applied; the deployed kiosk depended on them), SS10
  `harden_definer_search_path.sql`, SS12 `ss12_one_open_clock_event.sql`.
- **Edge/worker:** SS4 (`send-waitlist-offer` now requires admin auth) deployed; SS13
  worker email-filter validation auto-deployed via the workflow.
- **SS2 DONE** — family PINs are text end-to-end: `ss2_family_login_text_pin.sql` applied,
  `family-lookup` edge fn redeployed, `familyLogin` JS shipped. Leading-zero PINs (e.g.
  `0123`) now log in (verified). Staff PINs are a separate int-based system, untouched.
- **CI:** `.github/workflows/auto-merge-claude.yml` now auto-resolves version-file
  (`package.json` + `js/build-version.js`) merge conflicts — those were silently failing
  every auto-merge/deploy when two `claude/**` branches ran at once.
- **Waitlist Status page** (parent-facing, email-only lookup at `waitlist-status.html` +
  new `waitlist-status` edge function) shipped 2026-07-10, v1.20.1 — reviewed 2026-07-11
  (third sweep, see below). SS1 (weekly-rate quote/charge divergence) confirmed **fixed**
  in this same window — preview and submit now both route through `buildBillingBreakdown()`
  in `js/app.js`.

### Third sweep (2026-07-11) — top of the queue, see NEXT_STEPS.md for full sequencing
- **T1** — `send-schedule-confirmation` has no auth check and trusts client-supplied
  invoice amounts (High). Also reopens **SS13** (email regex misses `%`/`_` wildcards).
- **T2** — admin message inbox was deleted (commit `89cb987`) but two live features
  (Contact Us, new Waitlist Status "Message the Office") still write into `messages`
  with nobody able to read it (High, needs product decision).
- **T3** — `waitlist-status` edge fn ignores admin capacity overrides, a `settings.value`
  text-vs-object bug (High, smallest fix — pattern already proven in commit `6e9977c`).
- **T4/T5** — admin vs. parent waitlist "position" numbers disagree (global vs. per-room
  ranking); waitlist room-derivation hard-codes age boundaries that are admin-editable
  via Settings → Rates (both High).
- **Migration check** — confirm `add_billing_import_source.sql`,
  `create_staff_photos_bucket.sql`, `waitlist_inquiry_tour_reminders.sql`, and
  `waitlist_offer_type.sql` are actually applied in prod — none is documented as
  deployed, but the frontend on `main` already depends on all four.
- T6–T20 (ProCare AR dedup, billing preview inconsistencies, CI dist-conflict handling,
  rate-limiting gaps, misc low-severity cleanup) — see `docs/CODE_REVIEW.md` "Third
  Sweep" section and `docs/NEXT_STEPS.md` for the full list and order.

### Fourth sweep (2026-07-12) — full write-ups + fix status in `docs/CODE_REVIEW.md`
Whole-codebase pass (six parallel focused reviews + live-prod verification via the
Supabase catalog). **The five High items (FS1–FS5) were fixed this session**; FS6–FS30
remain to triage.

- **High — ADDRESSED 2026-07-12, FS1 fully closed 2026-07-14**
  - **FS1 [x]** — registration duplicate-prevention wasn't enforced (`month_key` column +
    index absent in prod; `submitRegistration()` never set it). **Fully fixed:** column
    added + backfilled, `submitRegistration()` stamps `month_key` on every insert, all 38
    pre-existing duplicate (child, month) groups in prod were manually reconciled with the
    owner (2026-07-14 — see `NEXT_STEPS.md` incident log), and
    `registrations_child_month_unique` is now **live in prod**. Duplicate confirmed
    registrations for the same child+month are rejected at the DB level.
  - **FS2 [x]** — admin "Add New Days"/"Edit Calendar" inserted a **duplicate** registration
    row. **Fixed:** `_arSubmit` now appends new days to the existing child+month registration.
  - **FS3 [x]** — a family's second same-month registration **overwrote** their draft invoice.
    **Fixed + deployed:** `create_billing_invoice_by_email` is now additive + clamps amount `>= 0`.
  - **FS4 [x]** — **stored XSS** via names in inline `onclick` in `admin-billing.js`.
    **Fixed:** handlers look the name up from `_arData` by id; no user text in any `onclick`.
  - **FS5 [~]** — billing `*_by_email` RPCs `anon`-executable (reopened SS5). **Mostly closed +
    deployed:** `get_outstanding_balance_by_email` revoked from PUBLIC/anon/authenticated
    (enumeration oracle closed, verified); FS3's additive+clamp kills the invoice
    zero-out/lower vector. Residual (tracked): anon can still *inflate* a known family's draft —
    bounded (no payment processor) + self-healing via admin regenerate; full fix = server-side
    amounts (T1/T11).
- **Medium** — FS6 `notify-geofence` client-supplied-recipient email relay;
  FS7 recurring days auto-booked/billed on closed/full/past dates & un-removable;
  FS8 cross-parent duplicate check hard-blocks unrelated families sharing a child name;
  FS9 `lookup.js` rejects valid 5–8 digit PINs (login impossible there);
  FS10 `admin-users` fails **open** when `admin_roles` is empty;
  FS11 email edge fns need only a session (not admin role) + don't validate recipient;
  FS12 generic CSV import shifts payment dates −1 day / to today;
  FS13 salaried YTD assumes employment since Jan 1;
  FS14 `restricted` role leaves Families/Billing/Reports/Messages tabs visible;
  FS15 `capacitySection` never restored on role switch;
  FS16 enrolling an email-less imported waitlist child → blank-email reg + no invoice;
  FS17 Planner floors seat consumption at 0, hiding later-month overbooking;
  FS18 formal email-offer flow is unreachable dead code;
  FS19 capacity baseline counts only the current ISO week;
  FS20 in-modal edits re-render the reg table unfiltered/unsorted;
  FS21 recurring days dropped when **creating** a family;
  FS22 CSV exports allow spreadsheet formula injection.
- **Low** — FS23 `.ilike()` `%`/`_` wildcard over-match (new SS13/T1-class sites +
  `request-pin-reset`); FS24 anon UPDATE on `staff_clock_events` allows same-day
  cross-staff tampering; FS25 waitlist "Message the Office" shows success toast on
  failure; FS26 graduation index merges distinct same-name children; FS27 admin-reg
  calendar keeps days across month nav (only first month invoiced); FS28 add-a-day
  billing failure swallowed while date is written; FS29 AR CSV "Days Since Invoice"
  always blank; FS30 Reports tab mislabeled "Billing".

_Prod-verified this sweep:_ `month_key`/its unique index **absent** (FS1); the anon
billing RPCs **deployed + anon-executable** (FS5, `search_path` correctly pinned);
`notify-geofence` deployed with `verify_jwt=true` (FS6 still reachable via the public
anon key). The old "billing-by-email RPCs probably not deployed / SS5 likely moot"
note is now **disproven** — they are live.

### Still to do from earlier sweeps (see NEXT_STEPS.md for the exact steps/sequencing)
- **SS1** — anon-read PII exposure: the public anon key can still read/modify
  families/students/staff (policies were over-permissive; a blanket tighten broke login
  and was rolled back). Groundwork RPCs are in `ss1_public_read_rpcs.sql`; the staged
  switch + policy drops still need a staging session.
- **SS5** likely moot (the billing-by-email RPCs aren't deployed in prod — verify).
- Remaining: SS3/SS9 (atomic registration RPC + capacity), SS11/SS16/SS17/SS18, SS19,
  S6 (PIN-reset per-IP throttle — now also covers `waitlist-status`/T10 and
  `send-waitlist-confirmation`/T14), S8 (anon-key rotation), and the browser-verified
  UX/perf items (U3/U4, V2–V6, P1–P3, M1). (S2 ✅, S4 ✅ closed by disabling Supabase
  signups, S7 reviewed-as-moot.)
- **`send-schedule-confirmation`** edge fn still needs deploying — and per T1 above,
  needs an auth-check fix before/alongside that deploy.

### Hard-won operational notes (don't repeat these)
- **`supabase/migrations/` is NOT auto-applied** — run migrations by hand in the SQL
  Editor. A committed migration ≠ a deployed one. Confirm a new RPC/column exists
  (`pg_proc` / `information_schema.columns`) before deploying code that needs it.
- **Auth/billing/RLS changes:** stage + smoke-test (parent login, kiosk, a test
  registration, admin tabs) before prod.
- **Don't run two `claude/**` branches editing shared files at once** — that caused a
  silent revert of a `supabase.js` line and the version-conflict merge failures. Sync
  with `main` before pushing.

---

## Development workflow

### Local dev (no build needed)
HTML pages load source files from `js/` directly. Open any `.html` in a browser or run:
```bash
python3 serve.py   # simple local server on :8000
```

### Building for production
```bash
npm install          # REQUIRED once per clone — build.js needs esbuild,
                     # otherwise `npm run build` dies with MODULE_NOT_FOUND
npm run build        # one-shot — outputs to dist/
npm run build:watch  # watch mode
npm test             # business-logic unit tests + source-drift guard
```

`npm test` runs `js/tests/business-logic.test.js`. Note that the pure functions in
that file are **copies** of production code (the `js/` files are browser globals with
top-level side effects and can't be `require`d). A source-drift guard at the bottom of
the suite re-reads `js/app.js` / `js/supabase.js` and fails if a copy no longer matches
its source, so divergence can't happen silently — if it fires, re-sync the copy. CI
runs `npm test` plus a `dist/` freshness check before any `claude/**` branch merges.
`scripts/build.js` bundles all JS into minified `dist/` files and patches the HTML to reference them (the HTML loads `dist/*.min.js`, not the `js/` source).

> ⚠️ **The deploy has NO build step.** Cloudflare Workers (`wrangler.jsonc` →
> `assets.directory "."`) serves the repo's files directly as static assets.
> Nothing runs `npm run build` on the server. Therefore **`dist/*.min.js` is
> committed to git**, and **you MUST run `npm run build` and commit the updated
> `dist/` whenever you change anything in `js/`** — otherwise the live site keeps
> serving the old bundle (or, if a referenced bundle is missing, 404s and the
> page's JS silently doesn't run at all). The idempotent `patchHtml` step keeps
> the HTML `<script>` tags from duplicating across rebuilds. Sourcemaps
> (`dist/*.map`) stay gitignored.

### Deployment
Push to `main` → Cloudflare Workers serves the committed files (including the
committed `dist/` bundles). **Rebuild + commit `dist/` before pushing JS changes.**
Edge functions in `supabase/functions/` are deployed separately (paste into the
Supabase dashboard editor, or `supabase functions deploy <name>`).

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
    finance-summary/     GET endpoint for the church ChMS finance integration (see below)
    send-invoice/        Emails a family their monthly invoice (ids only in, service-role reads out)

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
| `goose` | 🪿 Goose Room | 30–36 mo | active |
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
| `attendance_records` | Child attendance per care date (`present`/`absent`); no row = not yet marked. Admin-only (anon has no grants) |
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
The window is defined by the `registration_window` setting. `app.js` gates the UI on it
and has a handler for the `P0001` error a database trigger would raise.

> **⚠️ NOT ACTUALLY ENFORCED SERVER-SIDE (R24, found 2026-08-02).**
> `enforce_registration_window.sql` was **never applied to production** — neither
> `check_registration_window()` nor the `enforce_registration_window` trigger exists
> in the live database (verified against `information_schema`). The `P0001` handler in
> `app.js:1383` can never fire. Since `anon` holds INSERT on `registrations`, the window
> is enforced **only by client-side JavaScript** and can be bypassed by anyone posting
> directly to the API. Apply the migration to make the documented behaviour real.

---

## Environment / secrets

Set as Cloudflare Pages environment variables and Supabase Edge Function secrets:
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` — injected into HTML at build time or via `_headers`
- `SUPABASE_SERVICE_ROLE_KEY` — used by edge functions only (never exposed to browser)
- Push notification VAPID keys — set as edge function secrets
- `FINANCE_API_KEY` — shared secret for the `finance-summary` edge function (see below); same value must be set as `DAYCARE_API_KEY` on the ChMS side

---

## Finance summary API (for the church ChMS finance integration)

`supabase/functions/finance-summary/index.ts` — `GET`, header `X-Api-Key: <FINANCE_API_KEY>`, returns 401 if missing/wrong. Returns `{ updated_at, accounts: [], budget: [...] }` for the current month + 12 prior (13 months, oldest first). Deploy like any other edge function (paste into the Supabase dashboard editor or `supabase functions deploy finance-summary`) and set the `FINANCE_API_KEY` secret — neither is automatic.

- **`accounts` is always `[]`** — this app has no bank/operating-account balance data anywhere (no table, no settings key); that stays manual on the ChMS side.
- **`budget` rows**, per month × category × `type` (`actual`|`budget`), `amount_cents` integer:
  - `Tuition Income` — actual = live `SUM(billing_invoices.final_amount)` grouped by `billing_cycles.month`; budget = `settings.annual_budget_{year}.income / 12`.
  - `Payroll` — actual = live computed from `staff_hours`/`staff_clock_events` (manual entry takes precedence over clock events per staff/day) plus a flat biweekly-equivalent for active salaried staff; budget = `.wages / 12`.
  - `Payroll Taxes` / `Workers Comp` / `Other Payroll Expenses` / `Other Expenses` — both actual and budget come straight from the annual budget's `actual*`/plain fields, divided by 12 (no monthly-granular source exists for these).
- Known limitation: the Payroll actual calculation is a portfolio-wide trend approximation, not a payroll register — there's no staff termination date tracked (only `active`), so someone who left mid-window simply drops out of every month rather than just the months after they left.

---

## Common tasks

**Add a new room:** Add an entry to the `ROOMS` array in `js/supabase.js`. The room will appear automatically in registration, admin calendar, rates table, and reports.

**Apply a DB migration:** Paste the SQL from `supabase/migrations/` into the Supabase SQL Editor and run it.

**Deploy an edge function:** Use `supabase functions deploy <function-name>` from the repo root (requires Supabase CLI and project linked).

**Change payroll period length:** Adjust the `14` constant in `_buildPayrollPeriodList()` in `admin-reports.js`.
