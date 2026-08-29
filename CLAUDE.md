# Childcare Portal — Claude Code Guide

## ⚠ American English spelling and conventions

**Everything a human reads is written in American English.** Screen labels, button text, help
copy, toasts, error messages, emails to parents and staff, code comments, commit messages, this
file, `README.md`, and everything under `docs/`. This is not a style preference — this is a
St. Louis childcare center writing to its own families and staff, and "colour" or "behaviour" on
an admin screen reads as a typo to every one of them.

`-ize` / `-or` / `-er` / `-og`, and American date order (July 24, not 24 July):
color · behavior · organize · recognize · normalize · initialize · center · neighbor · gray ·
labeled · honor · judgment · enrollment · defense · utilization · authorized · realize ·
customize · minimize · analyze · fulfill · catalog · while (not "whilst").

**⚠ Four things that look British and must NOT be "corrected":**

| Leave alone | Why |
|---|---|
| `aria-labelledby` | An HTML attribute name. Renaming it silently unlabels the element for a screen reader, with nothing to see in a browser. |
| `'cancelled'` | A stored `registrations.status` value. Changing the spelling in code without a migration orphans every cancelled row in the live table. Same for the `behavior` **key** in `admin-incidents.js` — the display label is "Behavior", the stored value stays `behavior`. |
| `supabase/migrations/**` | A record of what was applied to the live database. A migration file's content should match what actually ran. |
| `dist/**` | Generated. Fix the source in `js/`, then `npm run build` — never hand-edit a bundle. |

Also leave alone the words that only look similar and are already American: `analysis`,
`analyst`, `optimistic`, `optimistically`, `realistic`, `fulfilled`, and `outsideFence` (which
contains "deFence" only by accident — this is why the check below is **case-sensitive**).

**How to check.** It should return nothing; worth running before opening a PR.

```
git ls-files | grep -vE '^(dist|supabase/migrations)/|package-lock\.json$' \
  | xargs grep -nE '\b(colour|neighbour|centre|centred|behaviour|organis[ei]|recognis|initialis|normalis|sanitis|optimis[ei]|licence|labelled|labelling|honour|grey|greyed|analyse|analysed|favour|enrolment|categoris|utilisation|judgement|defence|authoris|realise|realised|customis|minimis|whilst)' \
  | grep -v labelledby
```

---

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

## Finance tab overhaul — the Bookkeeper tab (2026-08-27)

Built from `Billing_UI_inconsistency_issues.zip` → `design_handoff_finance_hub/`
(README §6 + `IMPLEMENTATION_SPEC.md` §8–§9). The Ledger and Billing Report
halves of that handoff already shipped (`js/admin/admin-finance-hub.js`); this
session built the **third tab**, `Bookkeeper`, in `js/admin/admin-finance-bookkeeper.js`.

Six sub-views behind one pill nav: **Overview · Accounts Receivable · Room P&L
· Month-End Close · Reconciliation · GL Export**.

### ⚠️ Seven sidebar tools were retired, and that is the point

Finance's sidebar lost `ar`, `procare`, `revdash`, `dash`, `pnl`, `arrev` and
`budget` from `AP_TOOLS`. The director's original complaint was a shelf of
screens whose numbers were computed several ways and did not visibly agree;
adding a Bookkeeper tab while leaving all seven reachable next to it would have
kept every one of those disagreements and made the shelf longer.

- **Their `<section>`s stay in `admin.html`.** Unreferenced by `AP_TOOLS` means
  unreachable (the shell's own rule), so nothing that reads their DOM breaks.
  Delete the markup only once nothing does.
- **Attendance & Revenue is gone as a screen, not just as a nav entry.**
  Child-days is now a stat on each Room P&L card, read from the same dataset
  that card's revenue comes from — the two can no longer disagree, which is
  exactly what a separate Attendance screen could not promise.
- `yoy`, `expense` and `api` stay in the sidebar's Bookkeeper group; `discount`
  stays under Money In.
- **`scenario` and `model` moved to Planning → What-If**, per the handoff's own
  scope sentence ("Scenario planning and enrollment modeling have moved out of
  Finance"). ⚠️ Both were added to `AP_FULL_ONLY_KEYS`: Finance is in
  `AP_FULL_ONLY_TABS`, Planning is not, so the move would otherwise have
  quietly widened who can see wage and rate modeling.

### One dataset, still

Nothing in this tab derives a dollar figure of its own.

| Number | Source |
|---|---|
| Revenue, child-days, tuition/fees split | `_buildFamilyBillingData()` — what the Ledger and Billing Report bill from |
| Labor, per room and center-wide | `_buildRoomPnlData()` — what the retired dashboards read |
| AR rows, days late, aging bands | `_fhRows` itself, filtered to `owed > 0`. The banner promises "same figures as the Ledger"; reading the Ledger's own array is what makes that true rather than aspirational |
| Budget | `fetchAnnualBudget` / `saveAnnualBudget` — the same `annual_budget_{year}` setting the ChMS finance API reads |

⚠️ **The budget form merges, never replaces.** It shows four fields; the record
also carries the `actual*` fields `finance-summary` reads. A plain overwrite
would silently zero the church's actuals.

⚠️ **`_fhLoad()` calls `bookkeeperInvalidate()`.** Every Ledger write ends
there, and the bookkeeper figures are the same figures — without it a send or a
payment left the close screen showing pre-write numbers behind a tab switch.

### Reconciliation never touches a balance

It links existing `billing_payments` rows to a deposit record and nothing more.
Deposits, the payment→deposit assignment, and hand-entered items live in the
`finance_reconciliation` **settings** key — deliberately not a new table, and
deliberately not written into `billing_payments`: a payment the feed missed
must not become a row the Ledger then bills against. "+ Add item" rows are
tagged *added by hand* in the list for the same reason.

- **Confirm match is disabled unless the running total equals the deposit
  exactly.** No partial, no over-match — "close enough" hides a missing
  payment, a double entry, or an unaccounted processor fee.
- Only one deposit is in matching mode at a time, so a payment can never be
  provisionally checked against two.

### Two places the spec did not match the live schema

- **`billing_write_offs` has no `reviewed_at`** (and no DELETE grant). "Write-offs
  pending for this close" therefore means *recorded during the month being
  closed*, not *not yet ticked*.
- **A write-off is netted out of AR, not used to hide the family.** Scoped to
  the same trailing months the Ledger's `owed` figure spans — a write-off
  against a long-settled invoice must not quietly reduce today's balance.
- `billing_payments`' column is **`payment_method`**, not `method`.

### Still UI-only, and say so rather than implying otherwise

"Lock the month" records that the director considers the month closed; it does
**not** block Ledger edits to that month. A real lock is separate work. The
screen says this in a note rather than letting the checkbox imply enforcement.

### ⚠️ "Lock the month" freezes a number into `billing_summary` (2026-08-27)

Prompted by a real question: 2026 started partway through this app's life, so
some early months are hand-imported and the director wants this year's final
numbers frozen once complete, so 2027's Bookkeeper can compare against a
number that cannot drift out from under it later.

Checking "Lock the month" now writes the month's **currently live** total
into `billing_summary` per room (`data_source: 'month_lock_snapshot'`, via the
same `upsertBillingSummary()` the old Attendance & Revenue tool used) — the
exact table the historical fallback above already reads. Unchecking removes
the checklist flag but never deletes the snapshot row; re-locking overwrites
it with whatever is live at that moment.

⚠️ **A locked month must be read from exactly one place, never both.** The
first version of this session's fix only added the historical fallback for
months with *no* live data — it did nothing to change which source wins for a
month that has *both* a snapshot and live registrations, which is the normal
case right after closing a month. Caught by the user before it shipped:
without a lock-aware read, freezing a snapshot would have been a no-op —
`useLive = (tuition + fees) > 0` doesn't know or care whether the month is
locked, so any live registration still sitting in `registration_dates` would
keep outvoting the frozen number on every load, and the checkbox would
silently do nothing.

Fixed: `_bkLoad()` checks `_bkClose[mo]?.lock` **before** deciding a source —
`useLive = !locked && (tuition + fees) > 0`. Locked ⇒ always the frozen
snapshot, live data notwithstanding. Unlocked ⇒ the existing live-else-
historical rule, unchanged. Every sub-view that reads `byMonth` (Overview,
Room P&L, GL Export) shows a 🔒 badge on a locked month so a frozen number is
never visually indistinguishable from a live one.

Two things this is deliberately not:
- **Not enforcement.** The Ledger stays fully editable for a locked month —
  locking only changes what Bookkeeper *reads*, not what the database
  *accepts*. Editing an invoice after locking makes the Ledger and the frozen
  snapshot disagree until someone re-locks; the checklist detail line says so.
- **Not a labor lock.** Only revenue and child-days go into the snapshot —
  `billing_summary` never stored labor, and Room P&L's labor figure keeps
  coming from `_buildRoomPnlData()` (staff schedules/clock events) whether or
  not the month is locked.

### Fixed in passing

`renderFinanceHubTool()` reset `_fhTab` to `'ledger'` in state but never
re-synced pane visibility, so leaving on Billing Report and navigating back
showed the report under a highlighted Ledger tab. It now calls
`_fhSwitchTab('ledger')`.

### ⚠️ It shipped half-live for a day, and `dist/` is why

The merge landed correctly — source, `admin.html`, `scripts/build.js` and
`css/admin-portal.css` all had the tab. But `dist/admin.min.js` on `main` did
**not** contain a single byte of it, so on the live site the Bookkeeper tab
button existed with no code behind it. The old bundled `_fhSwitchTab()` has no
`bookkeeper` case, so clicking it hid the Ledger pane, hid the Report pane, and
showed nothing — the whole card went blank, which reads exactly like "this was
never built."

Cause: a concurrent `claude/**` branch (payment-security-fixes) branched before
this merge, ran its own `npm run bump` + rebuild, and the auto-merge's
`--theirs` resolution for `dist/*.min.js` (T9) took **its** bundle. That
resolution is right for a genuine build-artifact conflict and wrong here: the
newer bundle was built from the older tree.

⚠️ **`git log -- dist/admin.min.js` is not the check. Grep the bundle for a
string only your change introduces.** The dist-freshness CI job compares
`dist/` to the branch it runs on, so a bundle that is stale only relative to
*another* branch's merge passes it. After any `claude/**` merge that touches
`js/`, confirm on `main`:

```
git show origin/main:dist/admin.min.js | grep -c '<a symbol only your change adds>'
```

A `0` there means the feature is merged and not deployed, and nothing will say
so — the page just does nothing.

### ⚠️ Overview/Room P&L read $0 for a month billed before this table existed

Found live: January–March showed real revenue in the YoY report and the old
Financial Dashboard, but $0 in the new Bookkeeper Overview bar chart. Cause:
`_bkLoad()` computed every month's revenue from `_buildFamilyBillingData()`
alone, which reads `registration_dates` — for a month billed before
registrations were tracked in this app (or entered by hand for any other
reason), that table has nothing, so the live calculation is genuinely $0. The
real number lives in `billing_summary`, and `generateFinanceDashboard()` /
the YoY report already knew this: **prefer live revenue when it's nonzero for
the month, otherwise fall back to `billing_summary`'s `net_billed`.**
Bookkeeper had no fallback at all — a straight port of `_buildFamilyBillingData`
without the surrounding dashboard's historical branch.

Fixed by mirroring that exact fallback in `_bkLoad()`, per month and per room.
⚠️ **`billing_summary` has no tuition/fees split** — only a `net_billed`
total — so a historical month reports its whole total as tuition and $0 fees.
That's the same simplification `generateFinanceDashboard()` already makes;
it is not a new inaccuracy this tab introduced.

### Bookkeeper Overview absorbs Year-over-Year and Expense Lines (2026-08-28)

Prompted directly by the director after the tab first shipped: the bar chart
needed a white card behind it (it was sitting on the page's own cream
background, same color family, and read as unstyled), Expense Lines needed
its own screen removed with its editing folded into "Edit budget" instead of
just deleted, Year-over-Year needed to live inside Bookkeeper → Overview
under the budget card rather than its own sidebar entry, and ChMS Finance API
needed to move to Settings.

- **The bars now sit in a `.bk-card`.** Same white/border/radius as every
  other card on the tab — it was the one chart-shaped element on the page not
  wrapped in one.
- **"Budget lines" replaces the standalone Expense Lines tool**, added
  directly under the Annual Budget card's "Edit budget" form. Same data
  (`expense_config` setting, same `fetchExpenseConfig()`/`saveExpenseConfig()`
  the retired tool used, same four line types it supported — monthly $,
  annual $ + month, % of payroll, % of revenue) — verified against the live
  setting before building this, which held one of each of three of those four
  types. **GL Export's Rent/Supplies regex-match is unaffected**: it reads the
  same `expense_config` items either way, only where you add/remove a line
  changed.
- **Year-over-Year is now a card in Bookkeeper → Overview**, under the budget
  card. It calls the same `generateYoyComparison()` (admin-finance.js,
  untouched) into a `#financeYoyContent` container — deleted from its own
  retired `#financeYoySection` rather than merely left unreferenced, because
  `generateYoyComparison()` expects to be the only element with that id on the
  page; leaving the old one in place would have shadowed the new one via
  `getElementById()`'s first-match behavior. ⚠️ It still reads its year from
  `_financeYear()`, which reads a `#financeYear` selector that lived in the
  Financial Dashboard tool (`dash`, retired in an earlier session) — absent,
  it falls back to the real current year, same as it always has. It does
  **not** follow Bookkeeper's own `_bkData.year` if a director navigates the
  Ledger's month switcher into a different year; matches its pre-existing
  behavior exactly, not a regression from this move.
- ⚠️ **Lazy and cached, on purpose.** `generateYoyComparison()` runs two full
  `_buildRoomPnlData()` scans (current year, prior year) on top of everything
  `_bkLoad()` already computes — expensive, and the director had *just*
  flagged the tab's load as slow. It fires once per Bookkeeper session
  (`_bkYoyLoaded`, cleared by `bookkeeperInvalidate()`), not on every Overview
  re-render — saving a budget line calls `_bkRender()`, which would otherwise
  re-trigger both scans for no reason.
- **ChMS Finance API moved into Settings → Access & oversight**
  (`#financeApiCard`), not a new AP_TOOLS sidebar entry — Settings is a single
  continuous page by design (see the admin portal shell section above), and a
  second sidebar item under it would have reintroduced the "pick a screen
  first" pattern that redesign explicitly removed. `setupFinanceApiTester()`/
  `testFinanceApiConnection()` are unchanged; only the section moved.
  ⚠️ **Settings is not a full-only tab, but this tool needs to stay
  full-only** — it printed the church's own revenue/payroll summary and was
  gated by living under the `finance` tab (`AP_FULL_ONLY_TABS`). Moved
  `_hide('financeApiCard')` into `applyRoleRestrictions()`'s existing
  full-only block, right next to `setAccessCard`'s identical treatment.
- **The Bookkeeper sidebar group under Finance is now empty.** Ten tools have
  passed through it across two sessions (`ar`, `procare`, `revdash`, `dash`,
  `pnl`, `arrev`, `budget`, `yoy`, `expense`, `api`) and none remain — every
  one is now either a Bookkeeper tab sub-view or embedded in one. Their old
  `<section>`s stay in `admin.html`, unreferenced by `AP_TOOLS` (unreachable,
  per the shell's own rule) — **except** `#financeYoySection` and
  `#financeApiTesterSection`, deleted outright because this move reused their
  ids/markup at the new location, and a leftover duplicate would have
  shadowed the new one.
- **The tab's slow load is still open, and this session did not fix it** —
  it made it marginally worse by adding a second, lazy-loaded heavy call
  (YoY) alongside the load `_bkLoad()` already does across up to 12 months
  of `_buildFamilyBillingData()` + `_buildRoomPnlData()`. That per-month
  loop — not this session's additions — is almost certainly the real cost;
  a proper fix (caching across months, or computing the whole year in one
  pass instead of one call per month) is a bigger change than a same-session
  follow-up and hasn't been attempted here.

---

## Staff tab consolidation (2026-08-28)

Built from `design_handoff_staff/` (README + `Staff Tab Redesign.dc.html`),
same lens as the Classroom/Finance/Planning consolidations below. **Audit
finding: 9 tools, 3 groups → 4 tools, 3 groups.** Every retired key's real
logic is untouched — this only changes which tools are separate nav entries
versus tabs inside one screen.

| Kept as | Was | Tabs |
|---|---|---|
| **Build Staff Schedule** | Build Staff Schedule + Daily Staffing Requirement | This week's schedule (with a By room & shift / By worker view toggle) · Daily Staffing Requirement |
| **Staff Roster** | Staff Roster + Staff Directory | Roster · Directory (print) |
| **Payroll** | Payroll + PTO Settings + Geofence & Clock Reminders + Clock-In Integrity | Pay period · PTO policy · Time Clock (Settings / Integrity sub-tabs) |
| **HR & Handbook** (new) | — | Policies · Write-ups · Staff Injury Reports (moved here) |

Three single-source-of-truth pairs, same reasoning as every prior
consolidation: the `staff` table (Roster owns it, Directory reads it),
`apStaffing()` (Schedule owns it, the Requirement tab reads the same call
instead of a separate entry that could compute "enough staff" differently),
and Payroll (the PTO rate and the Time Clock config only ever matter in the
context of the numbers they feed).

### ⚠️ A real bug found and fixed on the way in: staffInjury/clockIntegrity were permanently blank

`staffInjuriesSection` and `clockIntegritySection` carried `pane: 'staffing'`
in `AP_TOOLS`, but their actual markup lived in `#tab-families` (next to Fire
Drills). `apShowSection()` hides every `.tab-pane` whose id isn't
`'tab-' + tool.pane` — so opening either tool from the sidebar hid
`#tab-families` (and the section along with it) while showing the empty
`#tab-staffing`. Same bug class as the Classroom tab's `attBoard`/
`incidents`/`drills` pane mismatch from the day before, in the opposite
direction (there the DOM was in the tab the tool's `pane` pointed away from;
here the DOM was in a *different* tab than `pane` claimed). Found by reading
`apShowSection()` against the two tools' real DOM location, not assumed from
a symptom report — nobody had filed one. Fixed by physically moving both
sections' bodies into `#tab-staffing` as part of the consolidation (Injury
Reports → HR & Handbook's third tab, Clock-In Integrity → Payroll → Time
Clock's Integrity sub-tab), so `pane` finally matches where the DOM is.

### Build Staff Schedule and Daily Staffing Requirement share one date field

They used to carry two independent "week of" pickers (`staffWeekOf` for the
schedule, `staffReqWeekOf` for the requirement) that could show two different
weeks at once. Now one field (`staffWeekOf`) drives both tabs —
`apRenderStaffReq()` reads it directly. The header cards above the tab strip
("Children this week" / "Est. labor cost") are the exact figures
`apRenderStaffReq()` already computes for its own footer (`apSchedHeaderStats()`
takes the same `sf`/`cost` values as a parameter rather than recomputing them),
so the shared header and the Requirement tab's own totals can never disagree.

⚠️ **The labor-cost estimate is deliberately the wage-model number (avg wage
× hours × payroll burden), not a sum of each assigned staff member's real
rate.** Build Staff Schedule's own room/shift grid is frequently incomplete
mid-week, and a cost built from "whoever's been assigned so far" would swing
on every single slot filled in, reading as broken rather than live.

### "By worker" is a read-only pivot, not a second editable grid

`renderScheduleByWorker()` (admin-reports.js) reads the room/shift grid's
*live DOM state* through `_readAssignmentsFromDOM()` — the exact same helper
`saveStaffSchedule()` and the XLSX export already use — and pivots it to
staff × day. It can never show an assignment that disagrees with what Save
would persist, and no new editing surface had to be built: "By room & shift"
stays the only place an assignment changes, matching the handoff's own
framing ("the room/shift spreadsheet is the default because that's the
format she actually works from; the per-person list is the alternate view").

### Time Clock's role gate falls out for free

The handoff's own open question — confirm `full`-only for the merged
Settings/Integrity tool — resolved itself: Time Clock is now a tab *inside*
Payroll, which was already gated to `full` via `AP_FULL_ONLY_KEYS`. No new
gating code needed, and it's automatically the stricter of the two former
gates (Clock-In Integrity's), exactly what the handoff asked for.

### HR & Handbook is open to `restricted`, except one tab

Policies and Write-ups don't carry the wage/PII sensitivity that gated
`staffInjury` on its own — so unlike Payroll, this whole tool is **not** in
`AP_FULL_ONLY_KEYS`. Only the Injury Reports tab needs the old gate (an
injury report names an employee, the part of their body, and where they were
treated). `applyRoleRestrictions()` (admin-settings.js) hides `apHrTabInjury`
and its pill button (`apHrPillInjury`) with inline `display:none` for any
role but `full` — the same "hide a specific control, not the whole tool"
pattern used for `financeApiCard` elsewhere in that function.

### Write-ups and Policies are genuinely new — everything else is a relocation

`add_staff_write_ups_and_hr_policies.sql` (**written this session, needs to
be applied manually per this file's standing migration process**) adds:

- **`staff_write_ups`** — one row per write-up (kind/note/occurred_at/
  issued_by_name/status). Two `SECURITY DEFINER` RPCs,
  `admin_submit_staff_write_up` and `admin_mark_write_up_signed`, both gated
  on `admin_role() IN ('full', 'restricted')` — same tier as filing an
  incident report. `authenticated` gets `SELECT` only; every write goes
  through the RPCs, closing the same dead-grant trap (`SX1`/`NEW-1`
  elsewhere in this file) a fresh `CREATE TABLE` would otherwise reopen.
  ⚠️ **There is no staff-facing e-signature flow in this pass** — the
  handoff's own screenshots show only the admin list view, so "Mark signed"
  records that the office has the acknowledgment on file (in person, on
  paper, verbally), the same way a real write-up binder would. A future pass
  could add a PIN-gated staff-side signature RPC without changing the
  table's shape.
- **`hr-policies`** storage bucket — private, `is_admin()`-gated, same shape
  as `child-documents` (not `enrollment-forms`, which is public — these are
  internal staff documents, not something meant for a public link). "View
  PDF" mints a short-lived signed URL per click (`fetchHrPolicyUrl()`) rather
  than embedding a long-lived public URL. Metadata (title/icon/"Updated"
  label/storage path) lives in a `settings` key, `hr_handbook_policies` —
  same "metadata in settings, file in storage" split `enrollment_forms`
  already uses.

### Verification run this session

`npm test` — 182/182, all drift guards green (nothing in the test suite's
hand-maintained copies touches code this session changed). `npm run build` —
`dist/admin.min.js` and `dist/supabase.min.js` rebuilt and grepped for new
symbols (`hrHandbookSection`, `renderStaffWriteUpsTool`, `admin_submit_staff_write_up`,
etc.) before committing — the exact check this file's own "it shipped
half-live for a day" incidents (Bookkeeper tab, Classroom tab) say to run.
**Not yet verified live**: the migration has not been applied to production
as of this commit — apply it in the Supabase SQL Editor before the Write-ups
or Policies tabs will do anything beyond render an empty list.

### ⚠️ The first pass only fixed the nav — the schedule grid still didn't match the mockup

Shipped, then flagged live: the director's screenshots of the actual mockup
(`design_handoff_staff/Staff Tab Redesign.dc.html`) showed a genuinely
different **Build Staff Schedule** grid than what went out — one compact
table (Room | Shift | day columns, one row per room+shift) versus the app's
pre-existing per-room block table (a tall stack of "AM Staff 1/2/3", "+
optional" rows, repeated per room). The first fix only reclassed two buttons
from `.btn-secondary` to `.btn-ghost`; the real gap was structural, and
`renderScheduleTables()`/`renderScheduleByWorker()` were never actually
compared against the mockup's own source before this session called the
work done. Read the `.dc.html` template directly (its `roomShiftGrid`/
`scheduleRows` data-shaping functions in `support.js`) rather than
re-guessing from a screenshot a second time.

Rebuilt both to match:

- **By room & shift** — one `<table>`, not one block per room. Every
  `<select class="sched-staff-select" data-date data-room data-shift
  data-slot>` kept its exact classes/attributes; only how they're grouped
  into rows/cells changed (a small stack of selects inside one day-cell
  instead of one table row per slot). This is what made the rebuild safe:
  `_syncGroup()`, `_readAssignmentsFromDOM()` (which `saveStaffSchedule()`,
  the XLSX export, and `renderScheduleByWorker()` all read through), and the
  day-print click wiring all key off those selectors, not DOM shape — none
  of them needed to change, verified by re-reading each one before touching
  `renderScheduleTables()`, not assumed. Kids-count/staff-needed figures
  (real, valuable, and not in the mockup's plain data-only cells) were kept
  as a small caption inside each cell rather than dropped — same "match the
  visual language while keeping the data" call this app made for
  Enrollment & Capacity's FTE table.
- **By worker** — rebuilt from a day-by-day pivot table (this session's
  first draft) into the mockup's actual shape: one row per person per
  (room, shift) they hold this week, with a real per-person cost (their own
  `hourly_rate` × assigned hours, not the header's wage-model estimate —
  salaried staff show `—` since a per-shift dollar figure isn't meaningful
  for them) and a coverage pill (`Full week` vs `N of 5 days`). Still
  read-only, still built from `_readAssignmentsFromDOM()`.
- **Week of / Children this week / Est. labor cost** — one row of three
  cards, matching the mockup, instead of the date field sitting separately
  above two stat cards. ⚠️ The date `<input>` itself had to stay a *static*
  DOM element (`apSchedHeaderStats()`'s mount uses `display:contents` so its
  two dynamic `.bk-stat` divs land as grid siblings of it) — folding the
  input into the JS-rendered mount would have destroyed and recreated it on
  every render, dropping its one-time `change` listener and any in-progress
  typing.
- **A real near-miss, caught before shipping**: the first attempt at this
  also wrapped the section's `<h2>` in a flex container to put the Print
  button top-right next to the title, matching the mockup exactly.
  `apShowSection()` only recognizes a section's own heading via `:scope >
  h2` — nesting it inside a wrapper div silently broke that selector and
  would have reintroduced the exact double-heading bug this app already
  spent a session fixing (see "Every redesigned Classroom-tab tool showed
  its own heading twice" below). Reverted to keeping `h2`/`p` as direct
  children of `.admin-section` and the button row as their sibling — Print
  sits in the button row, not next to the title, which is a real (small,
  deliberate) deviation from the mockup in favor of not reopening a closed
  bug class.

`npm test` — 183/183 (grew by one from another PR merged in between).
`npm run build` — rebuilt and grepped for the new grid/worker CSS classes
and `apSchedHeaderStats` before committing, same discipline as above.

---

## Classroom tab consolidation — Daily / Planning (2026-08-27)

Built from `design_handoff_classroom_tab/` (README + prototype `Classroom Tab
Redesign.dc.html`). Audited every screen in the Classroom tab and consolidated
per the director's sign-off in that handoff. **Records** (Care Calendar,
Family Directory, Missing Care Calendar) is explicitly out of scope — left
alone, to be redesigned in a separate session.

13 Classroom-tab screens → 7. **Daily**: Attendance Board, Incident Reports,
Fire Drills. **Planning**: Enrollment & Capacity. **Records**: unchanged, 3
screens. CACFP (already retired) stays retired.

| Kept as | Was | Reason |
|---|---|---|
| **Attendance Board** | Attendance Board + Classroom Roster | Roster's day-view manual In/Out marking was the only thing Roster had that the live board didn't. In/Out/Absent/Move now live directly in each room card. |
| **Incident Reports** | Incident Reports | Unchanged, plus **"+ Write a report"** — the director can file one herself. |
| **Fire Drills** | Fire Drills | Unchanged, plus **"+ Log a Drill"** — the director can enter a drill directly. |
| **Enrollment & Capacity** | Capacity Overview (month grid) + Room Schedule Planner (weekly AM/PM) + Planning's Room Capacity Overview (FTE/seat-day) | All three read the same registrations at different grains. Merged into one screen with a Day/Week/Month/FTE view switcher rather than picking a winner. |
| Retired from nav | Classroom Roster | Its day-view marking moved to the Attendance Board; its week/month browsing had no taker in the redesign. `dailyRosterSection`'s markup stays in `admin.html`, unreferenced — same convention as CACFP. |

### ⚠️ A real bug was found and fixed on the way in: the pane mismatch

`attBoard`, `incidents` and `drills` all carried `pane: 'daily'` in `AP_TOOLS`,
but their DOM sections (`attendanceBoardSection`/`incidentsSection`/
`fireDrillsSection`) live inside `admin.html`'s `#tab-families`, not
`#tab-daily`. `apShowSection()` hides every `.tab-pane` whose id isn't
`'tab-' + tool.pane` — so opening any of these three tools hid `#tab-families`
(and the section along with it) while showing the empty `#tab-daily`. Found by
reading `apShowSection()` directly, not assumed from the symptom. Fixed by
correcting `pane` to `'families'` on all three.

**That fix had a second-order trap.** `apToolAvailable()`'s 'staff'-role gate
was `tool.tab === 'classrooms' && tool.pane === 'daily'` — it had been using
`pane` as a stand-in for "is this a Daily-group, staff-visible tool," which
only worked because those three tools happened to carry the wrong `pane`
already. Fixing `pane` to its correct DOM-location value would have silently
dropped 'staff'-role admin logins from Attendance Board, Incident Reports and
Fire Drills. Fixed by keying that check on `tool.group === 'Daily'` instead —
a field that actually means what the check is testing for, decoupled from
where the section physically sits in the DOM.

### Attendance Board write path — resolved, not left open

The design handoff's own open question: does the office's In/Out mark write
to the same record the teacher app's check-in produces, or stay a separate
office-only record? **Decided: the same table.** New RPC
`admin_log_child_event` (migration `add_classroom_admin_authoring.sql`,
**applied and verified in production 2026-08-27**) writes into
`child_day_events` — the exact table `log_child_event` (the staff-app path)
writes into — so the parent app's daily record and the office's manual mark
can never disagree. It mirrors `log_child_event`'s own downstream effect: a
check-in also upserts `attendance_records.status = 'present'`, which is what
`center_headcount_rows()` already reads as the board's "marked" fact.

**Absent stays exactly what it already was** — a write to `attendance_records`
via the existing `saveAttendanceRecord`/`clearAttendanceRecord` (unchanged;
`authenticated`/admin already holds direct grants there), which
`center_headcount_rows()` was already reading as `marked = 'absent'`, distinct
from `attendance_status`. No new plumbing needed for that half — the
"Absent is its own explicit mark, distinct from not-yet-marked" requirement
was already true of the live schema.

**Move** reuses the existing single-day room move
(`updateRegistrationDateRoom`) — the same write the Capacity Overview
day-drill-down already made. The board doesn't get `registration_dates.id`
from `center_headcount_rows()` (that RPC returns `student_id`/`child_name`/
`room_id`, not a registration id), so it's resolved client-side from
`allRegistrations` by child name + today's date — the same array every other
admin day-view tool already lazy-loads.

⚠️ **`center_headcount_rows()`'s SQL source was never committed to this
repo** — `center_headcount_admin.sql`'s own comment says "Full body as
applied... see git history for the text." That's why this work did **not**
extend that shared function to carry `registration_date_id` directly, even
though it would have been the more obvious fix: reconstructing a function
whose true deployed source isn't in the tree risks silently dropping a field
(`marked`, `allergies`) that the live board depends on. Resolving the id
client-side avoided touching it at all.

### ⚠️ The board was never actually rendering — `allergies` is an array, not a string (found 2026-08-28)

Reported live: the Attendance Board sat on "Loading…" forever for every
room, on every day, for every admin. Root cause, found by calling
`center_headcount_admin()` directly against production and reading its real
shape: `allergies` comes back as an **array of `{label, severity}` chips** —
the same structure `admin-families.js`'s allergy editor writes — not a
string. `_abRender()` (written when the Attendance Board first shipped,
2026-08-16, before this session touched the file) did `(c.allergies ||
'').trim()` in three places. An array is always truthy, even `[]`, so that
line called `.trim()` on an array and threw a `TypeError` on the very first
child processed — **synchronously, inside `_abRender()`, which
`renderAttendanceBoard()` calls outside its own try/catch.** The exception
had nowhere to go but the browser console; the DOM was left exactly as the
loading placeholder had set it, forever.

⚠️ **This predates the Classroom Tab Redesign and was not introduced by
it** — confirmed by diffing: none of the three broken lines were touched by
this session's earlier work, which only added new code around them. It is
unknown how long the board was actually broken; nothing in the earlier
session's notes tested it against a room that had a child with any
allergies value at all (even an empty array), which is what it took to
hit this.

Fixed with one helper, `_abAllergySummary(allergies)`, used everywhere the
file reads a child's allergies: array → `.map(a => a.label).join(', ')`;
anything else → the old string-trim behavior, kept as a fallback rather
than assumed impossible. Verified the exact shape against a live,
rolled-back call to `center_headcount_admin()` before writing the fix, not
guessed from the column name.

**The lesson to keep:** a function called outside its own try/catch that
builds its output as one big template literal fails silently by construction
— any thrown error inside it leaves the DOM at whatever it was before the
call, which reads to a user as "stuck loading" with no error surfaced
anywhere they can see. Worth an eventual pass to wrap `_abRender()`'s own
body, not just the network call, so a future bug here fails loud instead of
quiet — not done in this fix, which was scoped to the one confirmed cause.

### ⚠️ Every redesigned Classroom-tab tool showed its own heading twice (found 2026-08-28)

Reported live, with screenshots: Attendance Board, Fire Drills, and by
extension every other tool this redesign touched showed the shell's header
("🚸 Attendance Board" + blurb) immediately followed by the section's own
identical `<h2>`, stacked right above the real content.

Root cause was in `apShowSection()` (admin-portal.js), not in any of this
session's own new markup. It hides a section's own duplicate `<h2>` only
when that heading "carries no real control" — deliberately, so e.g. Care
Calendar's inline "New Registration" button stays reachable — checked via
`h2.querySelector('button, input, select, a')`. But `setupCollapsibles()`
(admin-settings.js) injects a `.collapse-toggle` **button** into the `<h2>`
of *every* `.collapsible-section`, and every section this redesign
delivered (`attendanceBoardSection`, `incidentsSection`,
`fireDrillsSection`, `enrollmentCapacitySection`, `familiesSection`,
`allRegistrationsSection`, `missingCalendarSection`) still carried that
class from before the portal-shell redesign. The check found that button,
concluded the heading "carries a real control," and kept the duplicate
visible — on every one of them, every time.

⚠️ **The collapse toggle has been a dead control inside this shell for a
while, not just for these seven.** `css/admin-portal.css`'s
`.ap-on .admin-section.is-collapsed .collapsible-body { display: block
!important; }` forces every section's body open regardless of the
toggle's state — added when the shell itself shipped. A concurrent
session (`claude/planning-tab-design-v7aymy`, same week) had already found
and fixed this exact pattern for two Planning-tab sections
(`roomCapacityOverviewSection`, `ratioStepSection`) by dropping their
`collapsible-section` class — see that fix's own comment, still in
`admin.html` above `roomCapacityOverviewSection`. That was the right fix
for those two sections specifically, but it could never be a complete fix
on its own: **every other `.collapsible-section` in the app, present and
future, has the identical bug**, because the root cause is the shared
`apShowSection()` check, not any one section's markup.

Fixed both ways, on purpose:
- `apShowSection()`'s control check now excludes `.collapse-toggle`
  specifically (`button:not(.collapse-toggle), input, select, a`) — this
  is the fix that actually closes the bug class, for every section that
  has this pattern, including ones neither this session nor the concurrent
  one has touched.
- The seven sections above also had `collapsible-section` dropped from
  their markup, same as the concurrent session's fix — not required
  anymore given the check above, but it removes a genuinely dead button
  from the DOM rather than leaving it present-but-harmless, which is
  better hygiene and matches the established precedent.

**Not chased further in this pass:** a repo-wide sweep to drop
`collapsible-section` from every other section that doesn't need it. The
`apShowSection()` fix already makes that a cosmetic cleanup rather than a
correctness fix, so it's a fine follow-up, not an urgent one.

### ⚠️ Attendance Board's action colors and room-card layout drifted from the design source (fixed 2026-08-28)

Reported live with two side-by-side screenshots (the mockup vs. v2.11.2):
the In/Out/Absent buttons and the "Move →" select all rendered in a single
muted gray, and the room cards sat in a responsive multi-column grid.
Neither matches `Classroom Tab Redesign.dc.html`, and the fix was to go
back to that file's exact computed-style strings rather than eyeball the
screenshots again — `inStyle`/`outStyle`/`absentStyle`/`pillStyleFor()` all
carry literal hex values.

- **Each action now keeps its own color permanently**, not just on
  hover/focus: `.ab-act-btn[data-act="in"]` is green
  (`--green-text`/`--green-pale`), `[data-act="out"]` is tangerine
  (`--tang`/`--tang-pale`), `[data-act="absent"]` is deep tangerine
  (`--ap-deep-tang`/`--tang-pale`), filled solid when `.is-on`. No JS
  changes were needed — `_abActionsHtml()` (admin-attendance.js) already
  stamped `data-act="in|out|absent"` on each button; only the CSS was
  wrong. `.ab-move-select` is now the same green-pale/green-lt/green-text
  "pill" the design uses, not a plain gray border.
- **`.ab-pill` (the ratio badge) now matches `pillStyleFor()`'s bg/color
  pairs exactly**, not the `ok`/`warn`/`bad` tone convention used
  elsewhere in the admin: over-ratio is tangerine-pale on
  `--ap-deep-tang` (was `--tang-dark` — close but not the design's hex),
  at-limit is gold-pale on **navy** (was `--mustard-dark` — the design
  deliberately does not use the mustard warning color here), and ok is
  green-pale on `--green-text` (was `--green-dark`). Also dropped the
  pill's border — the design has none.
- **`.ab-rooms` changed from `grid-template-columns: repeat(auto-fit,
  minmax(300px, 1fr))` to a single-column flex stack.** The design source
  never wraps room sections into columns — `sectionStyle` is one div per
  room with `margin-bottom:16px`, rendered in sequence — so a wide admin
  screen showing three rooms side by side was a real layout deviation, not
  a viewport artifact of the mockup's narrower preview pane.
- `css/admin.css?v=20` in `admin.html` — the cache-busting query param this
  repo uses in place of content-hashed filenames (see R9 in the sixth
  sweep) — was bumped again for this change, same as every prior CSS edit
  this session.

### ⚠️ …and the single-column stack above was overridden by the director the same day

Asked directly, minutes after the single-column fix above shipped: put two
rooms side by side again, and make sure In/Out stamp a time that's visibly
labeled and stays. `.ab-rooms` is a two-column grid again
(`repeat(2, minmax(0, 1fr))`, collapsing to one column under 900px, same
breakpoint the shell's own drawer uses) — this is not a revert of the fix
above, it's the design mockup's own layout choice being overruled by the
person who actually runs the room. **If `Classroom Tab Redesign.dc.html` is
ever re-synced from, its single-column `sectionStyle` should not be
re-applied here without checking this note first.**

The check-in/check-out persistence half of the same ask turned out to
already work — verified directly against the live catalog, not assumed:
`admin_log_child_event()` writes an unconditional `child_day_events` row for
both `check_in` and `check_out`, and `center_headcount_rows()` computes
`attendance_status`/`last_event_at` fresh from the **latest** such row on
every call — there is no client-side state to lose on a refresh. Confirmed
against real rows already in production (a same-session round of manual
testing had left a real check-in/check-out pair on a real student). The one
actual gap: the "present" row showed a bare time (`8:45a`) with no label,
while "left" already said `out 7:57p` — asymmetric and easy to misread as
"nothing was stamped." Fixed by prefixing the present-state mark with `in `
too, in `_abRoom()` (admin-attendance.js). No RPC or schema change needed.

### Enrollment & Capacity's Week/Month/FTE sub-views were also still the pre-merge tools' own look (fixed 2026-08-28)

Reported live with four screenshots — one per sub-view — of the design
source's actual Day/Week/Month/FTE screens. Day was close (fixed alongside
the Attendance Board colors above), but Week, Month and FTE were still
rendering **the three original tools' pre-merge markup and styling**
unchanged, exactly as "Enrollment & Capacity — relocated, not rebuilt"
above says was done deliberately when this tool was first merged. Asked
the director directly rather than guessing: rebuild to match the
screenshots even where that would drop live functionality (the Week
view's AM/PM staffing split, the FTE view's 6-month trend and per-room
drawer), or match the visual language while keeping that data. **She chose
the latter** — so nothing enumerated in "One dataset, still" above or the
FTE report table's trend/drawer was removed.

- **Day**: rewrote `_ecRenderDay()`'s row markup and `.ec-day-*` CSS to the
  design's exact row shape — ratio printed under the room name instead of
  a separate flag pill, the enrolled count in the head serif at 1.3em, and
  the AT CAPACITY / AT RATIO STEP flag now genuinely silent (not just a
  muted "Open" pill) unless the room is actually over capacity or has just
  crossed a ratio boundary. `.ec-view-switch`/`.ec-pill` (shared by all
  four sub-views) changed from individually bordered gray pills to the
  design's single warm-gray track with a solid-navy active segment — the
  same "muted gray instead of the design's real color" pattern the
  Attendance Board buttons had.
- **Week**: `renderRoomSchedule()`'s AM/PM staffing table (admin-calendar.js)
  is **unchanged in structure** — same rooms-as-columns, dates-as-rows,
  AM/PM sub-columns. Only `.sched-cell`/`.sched-near`/`.sched-full` were
  recolored to the same green-pale/gold-pale/tangerine-pale-on-navy/
  deep-tang scheme the Day view and Month grid use, replacing the older
  mustard/tang-dark pairing — the exact color mismatch this file's earlier
  fixes describe, just on a table this session hadn't touched yet. The
  navy `<thead>` fill (`.staff-room-header`/`.staff-sub-head`) was left
  alone on purpose: those classes are shared with the real staff schedule
  tables in Staff → Build Staff Schedule, and recoloring them to match a
  single sub-view here would have restyled tools this redesign was never
  scoped to touch.
- **Month**: this was the one genuine layout gap, not just color.
  `renderCapacityOverview()` was showing the old **aggregate monthly
  utilization cards** (`.cap-card`, a progress bar per room for the whole
  month) — the design's Month view is a **day-by-day grid for one room**,
  switched by room-tab pills. Rewrote `renderCapacityOverview()` to render
  exactly that: room tabs + a Mon–Fri day grid, reusing the same
  `dayMap`-from-`registration_dates` construction `drawRoomCalendar()` (the
  pre-existing per-room calendar modal) already used, so the two can't
  disagree about what's booked. Clicking a day still opens
  `showDayRosterDetail()` — the same move panel Day view's "Move a child"
  button already opens, so nothing new had to be built for the move flow
  itself. ⚠️ **No data was dropped** — the aggregate monthly utilization %
  the old cards showed lives on in the FTE / Seat-Day sub-view's
  Capacity/Seat-Day Occupancy columns, which already computed the same
  number at the same whole-month grain; Month regaining a genuine
  day-by-day grid is what its own name (and the original "Capacity
  Overview (month grid)" description earlier in this file) always implied.
  The old `.cap-card` aggregate markup, `openRoomCalendar()`,
  `drawRoomCalendar()` and the `#roomCalModal` dialog were **left in place,
  unreferenced** — same "unreachable, not deleted" convention as the retired
  Classroom Roster and CACFP tools elsewhere in this file, kept rather than
  removed in case the per-room modal view was ever wanted back. ⚠️ **It was
  — see "Overview" below, added the next day.**
- **FTE**: kept its richer report-table shape (Enrolled/FTE/seat-days
  occ.-avail./% full progress bar/6-mo trend, click a room for the
  per-weekday drawer) rather than rebuilding it down to the design's
  plainer 5-column table — the director's own choice. Only recolored two
  spots that had drifted from this session's palette:
  `_renderCapacityOverviewTable()`'s over-95%-full bar and negative-trend
  text both moved from a hardcoded `var(--tang)` / literal `#7a2a18` to
  `var(--ap-deep-tang)`, matching the same deep-tangerine "something needs
  attention" tone used everywhere else this session touched.
- `css/admin.css?v=21`.

### Three real bugs found in the live review of the Week/Month/FTE fix above (fixed 2026-08-28)

Reported live with three more screenshots minutes after the fix above shipped.
Not a color/layout mismatch this time — two of the three were functional bugs,
one of them long-standing and unrelated to this session's redesign work.

- ⚠️ **Clicking a day cell did nothing — `showDayRosterDetail()`'s panel was
  rendering inside a `display:none` ancestor.** Its lazy-create path nested
  the panel inside `#roomCalModal .rcal-dialog` when that element exists —
  which it always does, since `#roomCalModal` is the pre-existing per-room
  calendar modal and is only ever unhidden by `openRoomCalendar()`, which
  neither Day view's "Move a child" button nor the new Month grid's day cells
  call. `.rcal-overlay.hidden { display: none; }` on the parent hides the
  whole subtree regardless of the panel's own `position:fixed`, which is a
  hard CSS rule with no exception — the panel's fixed positioning never
  mattered once its ancestor stopped being rendered at all. **This is not new
  to Month view** — Day view's Move button has called the same function since
  Enrollment & Capacity first shipped, so it was very likely broken the whole
  time, just never clicked through in a real browser. Fixed by always
  appending the panel to `document.body`: nothing about `.rcal-overlay`
  (no `transform`/`filter`) traps `position:fixed` z-index into a sub-context,
  so the panel still stacks above the per-room modal on the rare path where
  that modal happens to be open too — the conditional nesting was never
  buying anything, only risking exactly this.
- ⚠️ **The FTE table's "% full" was comparing a whole-month number to a
  single day's capacity.** `_buildCapacityOverviewRows()` computed
  `pct = enrolled / room.capacity` — but `enrolled` is `curEntries.length`,
  the count of **distinct children** registered in that room for the whole
  month, not a same-day headcount. Eleven different children cycling through
  a 9-seat room across a month (some Mon/Wed/Fri, others Tue/Thu) is normal,
  not "122% full" — and the Day/Week/Month grids next to it already showed
  every real day under capacity, which is what made the number read as
  obviously wrong rather than just high. Fixed by deriving `pct` from the
  seat-days figures already computed two lines above
  (`seatDaysOcc / seatDaysAvail`) instead of the distinct-enrollment count —
  the same daily-average math the day-grids use, so the two can't disagree
  the way this bug let them. This bug predates this session — verified by
  diff, this session only touched two color lines in that table before now.
- **Month's cell colors needed a stronger border, not a different fill.**
  The pale green/gold/tangerine fills matched the design source's literal
  hex values, but read as too close to the page's own cream background to
  register as a flag at a glance. `.ec-month-cell.is-near`/`.is-full` now
  also set `border-color` to the saturated tone (`--sun`/`--ap-deep-tang`)
  instead of the neutral tan border every cell started with — the fill
  stays the same pale tint, the ring around a flagged day is what carries
  the contrast now.
- `css/admin.css?v=23`.

### Attendance Board row layout reworked to a 2x2 action grid (2026-08-28)

Reported live with a screenshot of the intended layout, sent mid-turn while
the EC bugfixes above were still in flight. The five summary tiles (Here
now / Not in yet / Marked absent / Ratio watch / Allergies present) already
matched almost exactly — `_abTile()` already built them — except the Ratio
Watch tile's clear-state value read `'Clear'` where the screenshot wants
`'OK'`. Fixed as a one-word string change.

The child rows were the real rework: In/Out/Absent/Move used to sit in one
inline row of four controls; the screenshot shows In and Out stacked in
one column with their check time printed next to the button, Move and
Absent stacked in a second column beside it, and the name line carrying a
day-type pill, an allergy flag, an ABSENT label, and a drop-in badge as
independent, simultaneously-visible facts rather than one mutually
exclusive status string.

- **`_abActionsHtml()` rebuilt as two `.ab-actions-col` flex columns**
  (`[In, Out]` beside `[Move, Absent]`) instead of one inline row. No event
  wiring changed — `_abBindActions()`'s delegated listeners key off
  `data-act`/`.ab-move-select`, both still present, so the click/change
  handlers needed no changes at all.
- ⚠️ **There is no separate check-in-time vs. check-out-time field to draw
  on.** `center_headcount_rows()` exposes a single `last_event_at` (the
  *latest* event, whichever direction), not a pair. So In's time only ever
  populates while `attendance_status === 'present'`, Out's only while
  `'left'` — the other side reads `—` rather than a guessed or stale time.
  A child who was checked in and back out today will show a real time on
  Out and `—` on In, not both filled in.
- **The day-type (FULL/HALF) pill needed a new field the head-count RPC
  doesn't return.** Rather than extend `center_headcount_rows()` — its SQL
  source isn't committed to this repo, and this file already warns against
  reconstructing it blind — `_abResolveReg()` (already used for the Absent
  mark and the Move dropdown) now also returns `dayType` from the matching
  `registration_dates` row in `allRegistrations`, the same client-side
  resolution pattern every other admin day-view tool in this file already
  uses. Verified live via `center_headcount_rows()`'s actual jsonb shape
  (`dropin, marked, room_id, allergies, child_name, student_id,
  last_event_at, attendance_status`) before assuming the field was missing,
  not inferred from the JS alone.
- **Name-line badges are independent facts, not one exclusive `mark`
  string.** A child can be FULL-day *and* allergic *and* absent *and* a
  drop-in all at once; the old `mark` variable could only ever say one of
  those. `mark` is kept only as the read-only (`!canAct`, staff role)
  fallback text, where there's no action grid to carry the same
  information.
- `css/admin.css?v=24`.

### Absent didn't clear the In/Out display (fixed 2026-08-28)

Reported live: marking a child absent left their In/Out buttons showing
whatever they were before — a child checked in at 8:59a and marked absent
minutes later still showed "In · 8:59a" filled green next to "ABSENT" in
bold deep-tangerine, reading as a contradiction.

`_abActionsHtml()` computed each button's `is-on`/time purely from
`c.attendance_status`, with no awareness of `c.marked`. Fixed by making
Absent exclusive with In/Out **on the display**: `isIn`/`isOut` are now
`false` whenever `marked === 'absent'`, so both buttons read `—` and
unfilled the moment Absent is on, regardless of what `attendance_status`
says underneath.

⚠️ **This clears the display only, not the underlying event.** The real
`child_day_events` check-in row is untouched — `admin_log_child_event()`
has no delete/void path, and this file has stood against reconstructing
`center_headcount_rows()`'s query blind for exactly this class of risk.
Un-marking absent (clicking Absent again) doesn't lose anything: the row
falls back to `attendance_status` and the real check-in time reappears.

### Enrollment & Capacity: the Move panel was a popup, and the old % cards came back as "Overview" (2026-08-28)

Sent as four screenshots of the design source's own mockup (the same ones
already read earlier — placeholder room names "Infants/Toddlers/Preschool/
School Age" confirm it's the mockup, not the live app) plus a direct ask:
"no popup windows, its to go below." Every one of the four shows a
"— move a child" panel sitting **in the page flow directly under the
grid**, pushing content down, not floating over it.

**`showDayRosterDetail()` was a fixed-position, full-screen overlay** —
`position:fixed;inset:0;background:rgba(0,0,0,.55)` — a real modal, exactly
what the screenshots say it shouldn't be. Converted to an inline panel:

- CSS dropped the overlay entirely — `.day-detail-panel` is now a plain
  bordered card (`margin-top`, border, radius, no `position`/`inset`/
  backdrop) that simply sits wherever it's placed in the DOM.
- JS: `showDayRosterDetail()` gained a `parentEl` argument — the container to
  **append the panel into as its own last child** — so "below the grid"
  literally means "last child of the grid's own container," not a separate
  floating layer. Day view passes `ecDayContent`, Month view passes
  `capacityGrid`, and the revived per-room modal below passes `rcalBody`.
- ⚠️ **One reused DOM node, not one per view — and that's fine.** Whichever
  view's own `innerHTML =` wipe happens to run while the panel is nested
  inside it destroys the node along with everything else; the next open
  just lazily recreates it. Cheap, and none of these views are ever open at
  the same time, so there's never a case where destroying it drops a panel
  someone still needs.
- The close-button listener moved from `document.getElementById('dayDetailClose')`
  to `panel.querySelector('.day-detail-close')` — the old code looked it up
  by id *before* the panel was attached to the document, which happened to
  work only because the panel was unconditionally appended to `body` right
  there. Once attachment became conditional on `parentEl`, that ordering
  would have silently failed to bind the listener on a freshly created panel.
  Caught before shipping, not found live.
- The success-move handler already refreshed the old room-calendar modal and
  `renderCapacityOverview()` (Month) unconditionally; it now also re-renders
  Day view if that's the one currently open — a real gap from before this
  pass, where a move made from Day view's own Move button wouldn't visually
  refresh Day view afterward.

**Separately, asked directly: "we also had... cards that gave a percentage
capacity overview and if you clicked on a card it opened a calendar."**
That's the exact aggregate `.cap-card` view this session's Month rebuild
retired — deliberately left unreferenced-but-in-place rather than deleted,
per the note above. Asked where it should live now; **added back as a 5th
pill, "Overview"** (own independent month picker, matching FTE's own
already-established pattern) rather than replacing Month's room-tabs or
folding it into an existing view — Month answers "what does one room's
month look like," Overview answers "which rooms need attention this month,"
and the director uses both.

- `_ecRenderOverview()` is the exact pre-rebuild body of `renderCapacityOverview()`
  moved verbatim into `admin-enrollment-capacity.js`, targeting a new
  `#ecOverviewContent` container — same working-days-in-month math, same
  `bar-green`/`bar-orange`/`bar-red` thresholds (already fixed to a real
  3-tier distinction earlier this session).
- **Zero new click-wiring was needed for card → calendar.** `setupRoomCalendar()`
  (admin-init.js) has called its delegated `.cap-card[data-room-id]` click
  listener unconditionally since before this session touched any of this —
  rendering `.cap-card` markup again into a new container was the only
  thing missing. This is exactly what "left in place, unreferenced" bought:
  restoring the feature took zero changes to `openRoomCalendar()`,
  `drawRoomCalendar()`, or `#roomCalModal`.
- The per-room modal's own day-cell click already called `showDayRosterDetail()`
  — it now passes `rcalBody` as the panel's `parentEl`, so a move made from
  *inside* the calendar modal expands below the calendar grid, inside the
  modal's own scrollable area, rather than reintroducing a fixed overlay
  inside a fixed overlay.

### Director-authored records — she is signature 1, not a fourth role

For Incident Reports, the open question was how signature 1 works when there
is no teacher filing the report. **Decided: she signs as signature 1 too** —
same rule `submit_incident_report` already applies to a teacher ("filing IS
signing"), just from the office. New RPC `admin_submit_incident_report`
inserts the report and its `role = 'teacher'` signature from her own name in
one call; the existing three-signature order-guard trigger
(`incident_three_signatures.sql`) is **completely unchanged** and enforces
everything after it exactly as it does for a staff-filed report — the parent
still has to sign at pickup on a teacher's phone before the director can close
it. No schema change, no new signature role.

⚠️ **The "+ Write a report" form only captured five of the eleven fields the
staff app's own incident form does, until 2026-08-28.** `admin_submit_incident_report`
took `p_body_area`/`p_location`/`p_occurred_at` as parameters from day one, but
the compose UI in `admin-incidents.js` never rendered controls for them, and
the RPC had no parameters at all for `body_view`/`body_part`/`witnesses`/
`first_aid`/`after_notes`/`ratio_note` — six columns `submit_incident_report`
(the staff/PIN-gated path) has carried since `incident_three_signatures.sql`
and `incident_kind_and_after_notes.sql`. A report the director filed herself
printed a visibly thinner record than one a teacher filed, for no reason tied
to who typed it — the same "when it happened," "where," "what mark," "what
was done," "how the child was afterward," "who else saw it" and "the ratio at
the time" a teacher's form always asked for.

Fixed by `admin_incident_report_full_fields.sql` (**applied and verified in
production 2026-08-28**, same DROP-then-CREATE discipline as the two staff-side
incident migrations — a named-argument call from supabase-js would otherwise
match both the old 9-arg signature and a wider one, and PostgREST refuses to
pick between them). `admin_submit_incident_report` now takes the same six
extra parameters `submit_incident_report` does and writes all eleven columns.
The compose panel gained: a date+time picker with the same "Just now / 15 min
ago / An hour ago / Before lunch" quick chips, a location field, front/back +
quick-pick body chips (shown only when the kind maps to `injury`, hidden for
Illness/Other), first-aid chips, an "Since then" checklist, a witnesses
add/remove list, and a ratio-at-the-time field **prefilled from
`centerHeadcountAdmin()`** — the same present-children count the staff app
derives automatically rather than asks for, best-effort so a failed read just
leaves the field blank instead of blocking the form. Chip/checkbox/witness
state lives in `_incComposeState`, mutated by direct DOM toggles the same way
`staff-incident.js`'s `slIncState` is — never by re-rendering the whole tool,
which would have discarded whatever was already typed into the description or
action boxes on every click.

### Addenda — how to add to a filed report, since it can't be edited

Raised directly, immediately after the field-parity fix above shipped: once
"+ Write a report" is saved, the drawer offers **no way to add anything to
it** — no edit, no append, nothing. That is deliberate at the *signature*
level (`incident_signatures` rows are append-only by trigger, and
`incident_three_signatures.sql`'s own comment says "correcting a report means
the director returns it and the teacher files again"), but `incident_reports`
itself was never given any path to add information either — not a rewrite,
just an addition. "Return to the teacher" doesn't help: it flips `status` to
`returned` and nothing in the staff app has ever read or re-filed a
`returned` report, so that button was already a dead end before this session.

**Decided: an addendum, not an edit.** `incident_report_addenda.sql`
(**applied and verified in production 2026-08-28**) adds a new
`incident_report_addenda` table — one row per note, `incident_id` +
`note` + `added_by_name` + `created_at`, append-only by the same
`BEFORE UPDATE` trigger pattern as `incident_signatures`. `admin_submit_incident_report`
and `submit_incident_report` gain **no** new UPDATE path; the original
filing's fields never change once written. This mirrors how a real
incident/licensing record gets corrected — a dated note added to the file,
never a rewrite of what's already there — and it means a signed record's
content can never drift from what was actually signed, which is the whole
point of the append-only signature trigger in the first place.

- **Works at any stage** — before any other signature, after the parent has
  signed, even after the director has closed the record — because it writes
  to a different table entirely and never touches the signature order-guard.
  There's nothing about "the record is closed" that should stop the office
  from adding a clarifying note to it later.
- **Gated the same as filing**: `admin_add_incident_addendum` requires
  `admin_role() IN ('full','restricted')`, not `is_admin()` alone — same
  reasoning as every other write in this feature (the `staff` admin-portal
  role is documented read-only).
- ⚠️ **`incident_print_record()` was extended to return the addenda too**,
  not just the admin drawer. An addendum the director added has to show up on
  the document that actually leaves the building — otherwise the office UI
  and the printed/licensing copy could disagree about what's known. Same
  function signature, so this was a plain `CREATE OR REPLACE`, not a
  drop-and-recreate. `incident-print.html`/`incident-print.js` render an
  "Added since filing" section, shown only when at least one addendum exists
  — a report with none looks exactly as it did before this change.
- Parent visibility mirrors the report's own: an addendum is readable by the
  family only once the underlying report is `approved`, same condition as
  `incident_reports`' own "parent read own approved" policy — an addendum on
  a report the family can't read yet stays invisible until the report itself
  publishes.
- Verified live: a direct `UPDATE` on an inserted addendum raised the
  append-only exception (`23514`); `incident_print_record()` on a fully
  signed test report returned the addendum inside its `addenda` array
  alongside the report and signatures; all test rows deleted immediately
  after.

### A staff-filed incident never pushed the director — fixed 2026-08-28

Raised directly: the director should know about a report the moment staff
files it, not only once the parent has signed at pickup. Tracing the actual
code turned up two things, not one.

**The real gap:** nothing ever pushed her at all. `apDashDirector`'s "Needs
you" dashboard widget deliberately filters incident rows to `parentSigned`
only (she's signature 3, and a row she can't act on teaches her to scroll
past the queue) — so a freshly-filed report was invisible there by design.
That's correct for the *dashboard nag*, but the Incident Reports tool's own
"Awaiting sign-off" tab always showed it immediately, labeled "Waiting on
parent" — she just had to think to open that tab. There was no push telling
her a report existed until she did.

Fixed with a new worker route, `/notify-admin-incident`, fired from
`slSubmitIncident()` in `staff-incident.js` right alongside
`slNotifyParentOfIncident()` — same send-invoice posture as every other
sender in `worker.js`: the client sends an incident id and nothing else,
the worker re-reads the report with the service role and composes the
notification itself. ⚠️ **Caller auth is a staff PIN check, not a Supabase
Auth bearer token** (same shape as `/send-staff-broadcast`), because the
device filing the report is a teacher's phone on the public anon key with no
admin session to check a role against.

**Deliberately reuses `admin_push_subscriptions` and the existing "Notify
me" toggle** rather than a second subscription list — a director who
already turned notifications on for new parent messages (`admin-push.js`,
`/notify-admin-message`) should not have to find and flip a second switch to
hear about incidents too. The toggle label and its "you'll be notified"
copy were updated to say so. Still gated to `full` admins only at
`/admin-push-subscribe` — that gate was Messages-specific reasoning
("`restricted` never sees the inbox") that is now only half true (a
`restricted` admin *can* act on an incident), but it was left alone rather
than widened without being asked; one subscription list is now serving two
features on the narrower of the two gates.

⚠️ **A second thing was found while tracing this, and is still open — the
early PARENT notification this file has long documented may never have
actually pushed anyone either.** `notify_parent_of_incident()`
(`incident_three_signatures.sql`) only does `UPDATE incident_reports SET
parent_notified_at = ...` — no `net.http_post`, no call to `/send-push`
anywhere in `staff-incident.js`. Every description of this feature elsewhere
in this file ("stamps `parent_notified_at` early and the push carries no
detail") describes the *intended* design, not something re-verified against
the code before now. **Not fixed in this session** — flagged here so it
isn't lost, and because fixing it needs a design decision this session
wasn't asked to make: the missing-child alert's no-detail-on-a-lock-screen
reasoning applies here too, so the push text needs the same care
`/send-staff-broadcast`'s "opposite requirement" comment gives that one.

`admin_log_fire_drill` is the same shape for Fire Drills: an admin-gated twin
of `log_fire_drill`, same explicit column allow-list, `drill_date` and the
conductor still server-side.

**All three new RPCs are gated on `admin_role() IN ('full', 'restricted')`,
not `is_admin()` alone.** This file documents the 'staff' admin-portal role as
"Classrooms tab only (read-only roster view)" — `is_admin()` alone would have
let that role mark attendance, file incidents and log drills, which is a real
write, not a read-only roster. Verified live in a rolled-back transaction: a
probe `staff`-role email got `NULL` from `admin_log_child_event`; a probe
`restricted`-role email succeeded on all three. Client-side, the Attendance
Board's action buttons are hidden entirely for `currentAdminRole === 'staff'`,
so the UI doesn't offer a control that would fail.

### Enrollment & Capacity — relocated, not rebuilt

Week and Month sub-views are the original tools' own container markup
(`#roomSchedContent` / `#capacityGrid` and their controls) physically moved
into the new `#enrollmentCapacitySection`, with `renderRoomSchedule()` /
`renderCapacityOverview()` / `initCapacityMonthNav()` / `setupRoomCalendar()`
**completely unchanged** — same element ids, new home. The old section
wrappers (`capacityOverviewSection`, `roomSchedSection` in `#tab-daily`,
`roomCapacityOverviewSection` in `#tab-waitlist`) are **removed from
`admin.html`** rather than left behind — unlike Roster/CACFP, their content
relocated rather than being wholesale retired, so an empty shell would have
served no purpose.

The FTE/Seat-Day sub-view is `renderCapacityOverviewTool()` (unchanged logic)
given a new optional `targetMonth` parameter, because the design calls for its
own month picker, independent of Month view's — `_buildCapacityOverviewRows()`
now computes `curMo`/the 6-months-back trend comparison against whatever month
is passed in, not always "today."

Day is genuinely new (no prior screen existed at this grain): one row per
active room for a single date — enrolled/cap, staff needed (`Math.ceil(enrolled
/ ratio)`, booked registrations only — same "clock-in data is never read" rule
as Daily Staffing Requirement), a capacity flag, and "Move a child →" which
opens the exact same `showDayRosterDetail()` panel the Month view's day-cell
click already does.

`enrollCap` lives under Classrooms → Planning in `AP_TOOLS` (not the top-level
Planning tab, where its FTE predecessor used to sit) — moving a tool between
tabs has precedent (`scenario`/`model` moved Finance → Planning earlier).

### Everything applied and verified live, 2026-08-27

`add_classroom_admin_authoring.sql` — `admin_log_child_event`,
`admin_submit_incident_report`, `admin_log_fire_drill`. Verified post-apply:
`has_function_privilege` anon=false/authenticated=true on all three; a
rolled-back functional probe with seeded `restricted`/`staff` admin_roles
entries confirmed `staff` gets `NULL` and `restricted` succeeds on all three
(new incident/fire-drill/child-event rows all rolled back, nothing persisted).

`npm test` — 168/168. `npm run build` — `dist/` rebuilt and confirmed to
contain the new symbols (`admin_log_child_event` etc. in
`dist/supabase.min.js`; `renderEnrollCapTool`/`enrollmentCapacitySection` etc.
in `dist/admin.min.js`) before committing — the exact check this file's own
"it shipped half-live for a day" incident (Bookkeeper tab, above) says to run.

### ⚠️ It happened again the very next day, to this exact tab

`dist/admin.min.js` on `main` shipped with **zero** of this session's symbols
in it, hours after the PR above merged clean. Not a repeat of the same root
cause — a *different* concurrent `claude/**` branch's `--theirs` dist
resolution won and was built from a tree older than this merge. Confirmed
directly: `git show origin/main:dist/admin.min.js | grep -c enrollCap...` = 0,
and the bundle's own `__BUILD_VERSION__` banner (`v2.8.12`) didn't match
`package.json` (`v2.9.0`) — the same mismatch tell as the first incident.
`admin.html` already had the new markup, so the live site had brand-new
containers with no JavaScript behind them: every page this session touched
rendered its header and then nothing.

**The fix is always the same and always this cheap: `git checkout -B
<branch> origin/main`, `npm run build`, grep the bundle for a symbol only
your change introduces, push.** No source was wrong; only `dist/` was stale.
Fixed in a follow-up PR, re-verified against `origin/main` after merge.

⚠️ **This is now the second time in as many days.** With this many `claude/**`
branches landing on the same afternoon, `--theirs` on `dist/*.min.js` is a
coin flip that increasingly loses. Anyone shipping a `js/` change this week
should re-verify `origin/main`'s bundle for their own symbols **after** their
PR merges, not just before — a clean merge is not proof the bundle is live.

### A concurrent session restored `capacityOverview` to Planning — and that's correct

While this work was in flight, `claude/planning-tab-design-v7aymy` (working
from a *different* handoff, `design_handoff_planning_market`) put "Room
Capacity Overview" back as its own Planning-tab sidebar tool — the exact
entry this session's Enrollment & Capacity merge had retired. Its own
handoff's screenshots showed it as a standalone Planning tool, so from that
session's vantage point the retirement was a regression against what it was
building. **Not reverted here.** It restored the entry as a second mount of
the same `renderCapacityOverviewTool()` this session's FTE/Seat-Day sub-view
already uses (not a duplicate implementation), with `containerId`/`idPrefix`
parameters so the two mounts' drawer/row ids can't collide. Both now coexist:
the same table lives at Classrooms → Planning → Enrollment & Capacity → FTE/
Seat-Day *and* at Planning → Enrollment Outlook → Room Capacity Overview,
reading the same function, never able to disagree. Worth remembering: two
handoffs for the same tab landing the same week will not always agree with
each other, and the fix is to make both true rather than pick a winner
silently.

### Care Calendar redesign (2026-08-27, from `design_handoff_classroom_tab_full`)

A second, larger handoff superseded the first — it added **Records** (Care
Calendar, Family Directory, Missing Care Calendar) to the same Daily/Planning
consolidation, previously explicitly out of scope. Building all three at once
was declined in favor of one screen at a time, starting with Care Calendar —
lowest risk, since it has no PII-editing surface (that's Family Directory,
still to come).

**What changed:** `allRegistrationsSection`'s 12-column table (Submitted,
Entered By, Parent, Email, Phone, Child, Room, Dates, Full/Half, Bill,
Discount, Actions) → 5 columns (Parent, Child/Room, Pattern, Bill, Actions).
Parent's phone (or email, if no phone) now sits under the name instead of its
own column; discount sits under the bill amount instead of its own column;
the per-date pill list is replaced by a computed weekday-pattern summary.

**Pattern is a real computation, not a copy of the prototype's placeholder
text.** `_regPatternInfo()` (admin-calendar.js) buckets a registration's
confirmed (non-waitlisted) dates by weekday, groups them into ISO weeks by
each date's Monday, and calls a weekday "fixed" only if it's active in
nearly every week the registration spans (one missed week tolerated, e.g. a
closure) — otherwise the summary says "No fixed pattern" rather than
implying a regularity that isn't really there. Day type (Full/Half/Mixed)
and the month's day count are read off the same date set, so the summary can
never disagree with what "Edit bill" is charging for.

**Edit Days and Edit Bill stayed the existing modals, not the design's inline
row-expansion.** The 📅 action still opens `openEditDaysModal()` unchanged —
same calendar grid, same add/remove-day handlers, same billing recompute
(`_recomputeAndShow`), same parent push notification, same admin audit log.
That logic is billing-critical and already correct; relocating its rendering
into an inline per-row panel would have meant either duplicating
`editDaysCalGrid`/`editDaysBody` (real id-collision risk the moment two rows
are open) or rewiring the whole flow to a dynamic container, for a
presentational difference only. The trade was made once, explicitly, rather
than silently: full fidelity to the prototype's specific interaction was
given up in favor of zero risk to a tested, correctness-critical flow.
Revisit if that trade turns out to be the wrong one.

`npm test` — 182/182 (grew since the Daily/Planning session — other work
landed tests of its own in between). `npm run build` — `dist/` rebuilt and
re-verified against `origin/main` after merge, per the incident above.

### Family Directory redesign (2026-08-27/28, from `design_handoff_classroom_tab_full`)

Second of the three Records screens, after Care Calendar. Most of the
prototype's per-child field list — photo, name, `type="date"` DOB, room,
allergies, photo release, notes — turned out to already exist in
`renderModalChildRows()` almost exactly as specified; the real deltas were
the list view's button count, one confirmed live bug found while touching
this code, and a genuinely new feature (Documents).

**List → card actions: 5+ buttons → Edit, Calendar, and a "⋯" menu.**
`renderFamiliesList()`'s per-row Archive/Restore, Lock/Unlock Reg,
Login-unlock and Delete buttons moved into a `.fm-kebab-menu` dropdown;
Edit and Calendar stay visible (the handoff's "one Edit action instead of
5 buttons"). ⚠️ **Every existing button class and its delegated handler in
`setupFamilies()` is untouched** — only the markup that wraps them moved.
That was deliberate: the archive/lock/delete logic is already correct and
already logs to `admin_audit_log`, so the redesign only needed to relocate
buttons, not re-implement what they do. The kebab toggle/close-on-outside-
click/Escape wiring is new, added ahead of the existing per-button checks
in the same delegated `document` click handler rather than a second one.

**FS21 fixed while in this file — allergies dropped only on the CREATE
path.** CLAUDE.md has carried this as open since the fourth sweep:
`saveFamilyModal()`'s CREATE branch passed `addStudent()` only
name/dob/room/discount/photo, while the UPDATE branch a few lines below
also passed `recurringDays`/`allergies`/`careNotes`/`photoRelease`. A child
added while creating a brand-new family started with no allergy record and
no `allergies_reviewed_at` stamp — a safety field silently dropped, not a
convenience one. Fixed by mirroring the UPDATE branch's four fields into
the CREATE branch's `addStudent()` call. The severity note this file
already carried (0/150 live students were ever created through this path,
so latent rather than active) is now moot — the path is fixed, not just
documented as risky.

**Documents — built as real per-child file storage, not a placeholder.**
New private bucket `child-documents` (`add_child_documents_bucket.sql`,
**applied and verified live 2026-08-27/28**: `pg_policy` inspection
confirmed the single policy is scoped to `authenticated` + `is_admin()`,
`FOR ALL`, no anon or parent access at all). ⚠️ **Deliberately no metadata
table.** One folder per child, named by `students.id` — `listChildDocuments()`
reads `storage.list(studentId)` directly, so there is nothing to keep in
sync if a file is removed from the Supabase dashboard instead of the app,
unlike a join-table design that could silently orphan a row. This mirrors
`child-profile-photos`' existing parent-facing upload path
(`uploadChildProfilePhotoAsParent`), which already scopes by
`<studentId>/...` for exactly the same folder-based-RLS reason — Documents
just doesn't need the parent half of that policy, since this bucket has none.
- **Admin-only, unlike the photo bucket, on purpose.** The handoff's
  Documents section is office paperwork (immunization records, signed
  forms), not something the redesign asked to expose in the parent app.
  Adding a parent-read policy later is a strictly additive change if it's
  ever wanted — nothing here forecloses it.
- **"📷 Scan document" is a camera-capture file input** (`capture="environment"`,
  `accept="image/*"`), and "⬆ Upload file" is a plain file input
  (`image/jpeg|png|webp`, `application/pdf`). There is no OCR or actual
  scanning pipeline — "scan" means "take a photo with the device camera,"
  which is what capture-attribute file inputs actually do on a phone
  browser, and is the honest, buildable interpretation of the handoff's
  copy rather than a bigger feature nobody asked for.
- **Upload/remove write immediately, not deferred to Save.** Unlike the
  profile photo (which stages deletes in `_fmPhotosToDelete` until the
  family record itself saves successfully, so a cancelled edit can't orphan
  a still-referenced path), a document has no DB row pointing at it to keep
  in sync — there's nothing for an unsaved edit to leave inconsistent, so
  it writes straight through.
- **Gated on the child already being saved** (`child.id` must exist) — a
  child row added in the modal but not yet saved has no id to fold into a
  storage path, so its Documents block shows "Save this child first, then
  reopen Edit to attach documents" instead of controls that would fail.

**Also fixed in passing:** the PIN fields' `maxlength="4"` didn't match the
`/^\d{4,8}$/` validation already enforced in `saveFamilyModal()` — an admin
literally could not type a 5–8 digit PIN the app would otherwise accept.
Bumped to `maxlength="8"` in both fields, with the placeholder text updated
to say "4-8 digits" instead of "4-digit" throughout.

`npm test` — 182/182. `npm run build` — `dist/` rebuilt and re-verified
against `origin/main` after merge, same discipline as Care Calendar above
(this is now the standing practice for every `claude/**` merge on this repo,
not just the two sessions that got burned by it).

---

## Design handoff build — staff, parent, director (2026-08-16)

Built from `Parent_communication_expansion.zip` (staff app, parent app, director
desktop, printed report). **Finance is deliberately untouched** — the handoff
says twice that `2a`/`2b` are "an open decision, not a spec" and the client is
iterating on it separately.

### ⚠️ Incidents now take THREE signatures, in order, enforced in the database

`incident_three_signatures.sql` + `incident_kind_and_after_notes.sql`, **applied
and verified 2026-08-16.** Teacher (filing *is* signing) → parent at pickup on
the teacher's phone → director. A `BEFORE INSERT` trigger on
`incident_signatures` raises `23514` on any out-of-order signature, a second
trigger makes them append-only, and `UNIQUE (incident_id, role)` stops a
duplicate. Safe to enforce retroactively because `incident_reports` was **empty**
— zero reports had ever been filed.

- **`incident_print_record(id)` is the only way to a printable copy.** It returns
  `{ok:false, reason:'incomplete'}` until all three exist — measured against a
  *full admin*, refused at 0, 1 and 2 signatures. `incident-print.html` holds no
  fallback copy of the record, so there is no client render path. Never add one.
- ⚠️ **Notification and publication are deliberately different moments.** The
  handoff says the parent is told as soon as the teacher signs; the applied
  2026-08-12 decision says the readable report waits for the director. Both are
  true: `notify_parent_of_incident()` stamps `parent_notified_at` early and the
  push carries no detail, while the `parent read approved` policy still gates the
  readable copy on sign-off. The pickup signature needs no portal read at all.
- ⚠️ **One function, never two overloads.** supabase-js sends *named* params, so
  a 9-arg and a 15-arg `submit_incident_report` both match nine named arguments
  and PostgREST fails with "Could not choose the best candidate function". Create
  the wider one, `DROP` the narrower one, restate the grants.
- `incident_type` stays the four-value CHECK (`behavior` is a **stored value**);
  the handoff's six chips live in the new `incident_kind`.

### Also new

| Thing | Where | Note |
|---|---|---|
| Staff **My schedule** | `js/staff/staff-schedule.js` | Two week strips, own shifts only. `staff_my_schedule()` resolves the caller from their own PIN — no parameter widens it to the roster. |
| **Shift swaps** | `shift_swaps` | Accepting moves the `staff_schedules` row and stamps the swap in one transaction. An accepted swap is **never deleted** — the giver still sees it struck through, and that strikethrough is the record. |
| **Missing child** | `js/staff/staff-missing.js` | A broadcast on two channels: in-app banner (poll) + push (`/send-staff-broadcast`). **No recipient argument on any RPC, and there must never be one.** Banner on every tab with no dismiss control. |
| **Attendance board** | `js/admin/admin-attendance.js` | Office mirror of the head count. |
| Parent **Documents** | `js/portal/portal-documents.js` | Replaced the Billing *placeholder* tab, restoring the handoff's five. |
| **Announcements** | `js/admin/admin-announcements.js` | `kind` is a branch: a closure is the only kind that should ignore quiet hours. Publishing pushes **by id**; a draft never pushes. |
| **Needs you** queue | `apDashDirector` | Inline actions per row. Incident rows are filtered to `parentSigned` — she is signature 3, and a row she cannot clear teaches her to scroll past the queue. |

⚠️ **`center_headcount_rows(date)` is a shared body with NO authorization.**
`center_headcount()` gates it on a PIN, `center_headcount_admin()` on
`is_admin()`, and it is revoked from `anon` *and* `authenticated`. Do not write a
second admin-side query — the office and the lawn disagreeing about who is in the
building during a drill is the worst failure this data has.

⚠️ **`attendance_records` has no `student_id`** — it keys on `child_name` plus a
`registration_id`. Joining on `student_id` cost a live outage of the staff head
count here: the broken function replaced a working one, grants verified clean,
and nobody executed it. **Verifying grants is not verifying a function.**

### ⚠️ Push works, and it is in `worker.js` — NOT `supabase/functions/`

**A note here previously claimed `/send-push` did not exist and that nothing in
this app pushes to a phone. That was wrong**, and it was wrong because it was
concluded from `ls supabase/functions/` alone. Push is a **Cloudflare Worker
route**, and the whole thing has been live for months:

| Route (`worker.js`) | Auth | Notes |
|---|---|---|
| `/push-subscribe` | family session | 62 live family subscriptions |
| `/staff-push-subscribe` | **named staff + PIN** | staff_id derived server-side, never from the body |
| `/send-push` | `is_admin()` RPC, or service role | CSRF origin check, 410 cleanup |
| `/send-staff-broadcast` | **named staff + PIN** | every staff phone; missing-child |
| `/send-staff-push` | service role only | one staff_id; used by `check-missed-clocks` |

`sendWebPush()` does real VAPID JWT signing (ES256) and RFC 8291 `aes128gcm`
payload encryption. Keys are wrangler secrets: `VAPID_PRIVATE_KEY` (JWK),
`VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, minted by `scripts/generate-vapid-keys.js`.
`docs/PROCARE_FEATURE_ANALYSIS.md` already recorded it as "plumbing already
built" — **read that table before concluding a capability is missing.**

**The real gap was subscriptions, not code.** Only `clockin.html` ever asked
staff to subscribe, so there were **3 subscriptions against 31 active staff** —
a "broadcast to every phone in the building" would have reached three. The staff
app now asks too (`js/staff/staff-push.js`), and the ask names the
missing-child alert rather than "notifications", because somebody who declines
shift reminders should still be asked about the alert that gets a child found.

⚠️ **Send by reference, never by wording.** `/send-staff-broadcast` takes an
`alert_id` and `/send-push` takes an `announcement_id`; the worker re-reads the
row with the service role and composes the text. No title, no body, no recipient
from a browser — this is the `send-invoice` posture and it is what keeps
T1/FS6/FS11 from applying. The older free-text shape on `/send-push` still works
for the call sites that predate this; **new senders reference a row.**

⚠️ **The two channels are not interchangeable.** The missing-child in-app banner
polls every 15s and needs no permission grant, no subscription and no push
service to be up; the push reaches a pocket. Push is fired best-effort *after*
the alert is raised and its failure never blocks the raise. Do not delete either.

⚠️ **Incident pushes carry no detail on purpose** (a lock screen is read in
public) — but the missing-child push carries the description deliberately,
because the audience is staff who need it to search. Opposite requirements; do
not "fix" one to match the other.

Still unwired: the closure composer's "block the day" / "credit the tuition"
checkboxes record intent only. Wiring them must go through the recompute-only
billing path — **never a delta**.

---

## Safety & compliance — head count, fire drills, staff injuries (2026-08-14)

`supabase/migrations/staff_injury_and_headcount.sql`, **applied and verified in
production 2026-08-14**. Three additions, two director's tools
(`js/admin/admin-safety.js`), one new staff-app tab (`js/staff/staff-headcount.js`).

### ⚠️ "Present" is the LATEST attendance event, never `checked_in`

`list_room_children.checked_in` is `EXISTS(check_in)` and **stays true after a
child goes home**. On a roster that is cosmetic; on a fire drill sheet it sends a
teacher back into a building for a child who left at noon. The RPC now also
returns `attendance_status` — `present` / `left` / `not_arrived` — and that is
what every count reads. `checked_in` is kept **only** so a stale cached bundle
does not break; do not add a new caller.

### ⚠️ Nobody has ever checked in

At the time of building, `child_day_events` and `attendance_records` were both
**empty** — zero check-ins ever, because the staff app shipped 2026-08-12 and the
habit does not exist yet. So a literal "who is checked in" count says the
building is empty. The head count screen therefore:

- falls back to **who is booked today** and says so in the loudest banner on the
  page (a calm `0` during a fire drill is the worst possible failure);
- makes the **tick-off**, not the check-in data, what the drill record is built
  from, so the drill works identically either way.

**None of this can be deleted once check-ins start** — a day where nobody
happened to tap Check in looks exactly the same.

### Staff injuries are NOT child incidents

`staff_injury_reports` is a **separate table from `incident_reports` on purpose**
and the two must never be merged. `incident_reports` carries a `parent read
approved` policy keyed on `parent_owns_student`; a staff injury has no student
and no family that may ever read it. It has **no parent-facing policy at all**,
no DELETE grant, and the tool is gated to the `full` admin role
(`AP_FULL_ONLY_KEYS`) because the report names an employee, their body, and where
they were treated.

- `reported_at` is a **legal clock**, not a display timestamp: Missouri gives the
  employer 30 days from knowledge to file the First Report (RSMo 287.380). The
  director's queue ages from it and turns red at 30 days.
- The injured person and the filer are **allowed to differ** — someone with a
  hurt wrist cannot type, and someone at urgent care is not filing their own.
- Deliberately **not** offline-queued: a queued injury report sits on a phone
  with a legal clock running against a date-stamp nobody has. It fails visibly.

### Fire drills

`fire_drills.snapshot` stores the names and rooms **as they stood at the moment
of the drill**, plus `source: 'checked_in' | 'booked'` so the record says how the
count was known. Counts alone cannot answer "who was in the building on March
3rd", and re-deriving it later changes the answer the first time somebody edits
that day's registrations. No DELETE grant — a drill that happened cannot be
un-held. `log_fire_drill` takes a jsonb payload with an **explicit column
allow-list**; `drill_date` and the conductor are server-side (injection-tested).

---

## ⚠️ A PIN-gated RPC must be VOLATILE, never STABLE (outage 2026-08-19)

Staff clock-in went down with `25006: cannot execute INSERT in a read-only
transaction`. Fixed by `fix_pin_gated_rpcs_must_be_volatile.sql`, **applied and
verified in production 2026-08-19.**

**PostgREST runs a `STABLE` or `IMMUTABLE` function in a read-only transaction.**
`staff_clock_status`, `staff_my_schedule` and `active_missing_child` were each
declared `STABLE` — correct for their own bodies, wrong for the PIN gate they
call:

```
staff_clock_status -> staff_id_for_pin -> verify_staff_pin
                   -> record_pin_attempt  => INSERT INTO pin_attempt_log
                   -> UPDATE staff        (lockout counter)
```

`throttle_staff_pin_attempts_APPLIED.sql` (2026-08-12) made `verify_staff_pin`
**write on every call, success and failure alike**. From that moment every
`STABLE` caller of the PIN gate raised `25006` on every call. Neither change was
wrong on its own; the combination was.

⚠️ **`VOLATILE` here is the honest declaration, not a workaround.**
Authenticating by recording the attempt is a side effect. **Every one of the 21
PIN-gated RPCs must be `VOLATILE`** — if a new one reads and you are tempted to
mark it `STABLE` because "it only selects", it does not: it writes an attempt row
through `staff_id_for_pin` before it reads anything.

**Two of the three had never worked at all**, and this is the part worth
remembering:

| Function | Created | Symptom |
|---|---|---|
| `staff_clock_status` | 2026-08-19 | Broke the day it shipped. Noticed within hours because **0 clock events were recorded that day against 13 the day before** — staff standing at the door unable to clock in. |
| `staff_my_schedule` | 2026-08-16 | Born broken. Staff "My schedule" had never once loaded. |
| `active_missing_child` | 2026-08-16 | Born broken. **The missing-child in-app banner has never worked** — it polls every 15s and threw every time. |

⚠️ **The missing-child banner is the one to sit with.** This file describes it as
the resilient half of a two-channel alert — the channel that "needs no permission
grant, no subscription and no push service to be up." It was dead for three days
and nothing said so, because **no alert had ever been raised**, so the failure
had no way to surface. A safety feature that is only exercised in an emergency
is one that has to be tested on purpose; nobody will report it broken.

**How to catch this class:** a PIN-gated RPC returning `NULL` for a wrong PIN and
`25006` for a *correct* one looks like "bad PIN" from the browser. Test the
happy path, not just the rejection. `select provolatile from pg_proc` is the
one-line check — see the verification query at the bottom of the migration.

---

## ⚠️ RLS DOES NOT STOP `TRUNCATE` (found and closed 2026-08-14)

`anon` held `arwdDxtm` — **every** privilege, including `DELETE` and `TRUNCATE` —
on eight tables: `staff_clock_events`, `registrations`, `registration_dates`,
`staff`, `waitlist_applications`, `cacfp_menus`, `client_error_log`,
`deletion_requests`. RLS is enabled on all eight, which is exactly what hid it.

- **DELETE was not exploitable.** No table had a DELETE policy naming `anon`, so
  the statement affected zero rows. Proven as the `anon` role in a rolled-back
  transaction: `before=1547, deleted_by_anon=0, after=1547`.
- **⚠️ TRUNCATE was.** TRUNCATE does not read rows, so **row-level security never
  applies to it** — the grant alone is sufficient. Anyone holding the public anon
  key, which ships in the browser on every page, could have erased every
  registration, every care date, the staff roster, the waitlist, and five months
  of payroll clock events. No soft delete, no application copy: recovery would
  have been a database restore.

Revoked from `anon` **and** `PUBLIC` on all eight in
`revoke_anon_delete_truncate_clock_events.sql`. `SELECT`/`INSERT`/`UPDATE` were
left untouched — several are load-bearing (registration submit, kiosk clock-out).

**Never read "RLS is enabled" as "writes are controlled."** Check `relacl` for
the `D` bit. R4's write-up said this table held "SELECT/INSERT/UPDATE" and it
held everything; the write-up was believed for months because nobody re-read the
catalog.

### Whole-schema sweep (2026-08-14) — `anon_grant_sweep_2026-08-14.sql`

All 51 tables audited. RLS on every one; no DELETE/TRUNCATE left anywhere. Dead
grants (a grant with no policy that permits it) revoked on seven tables —
`client_error_log` SELECT/UPDATE, `cacfp_menus` INSERT/UPDATE,
`deletion_requests` SELECT/UPDATE, `registrations` UPDATE,
`registration_dates` UPDATE, `students` SELECT, `waitlist_applications`
SELECT/UPDATE. Views: one, `security_invoker` on, no anon SELECT. All 32
anon-executable definer functions have `search_path` pinned.

**⚠️ How to probe a grant, because three obvious methods lie:**

| Wrong method | Why it lies |
|---|---|
| `UPDATE t SET col = col` | Needs SELECT to evaluate `col`, so it fails on missing SELECT and looks like RLS held. Use a blind `SET col = <constant>` with no WHERE. |
| Probing an empty table | 0 rows updated whatever the policy says. Seed a row as `postgres` first. |
| `'anon' = any(polroles)` | Misses `polroles = '{0}'` — that is **PUBLIC**, which includes anon. It hid the `Public insert` policies entirely. |

Also: `RETURNING`, a subquery inside an INSERT, and an FK check all need SELECT
on the table they touch. A `42501` from any of those says nothing about the
privilege under test. Always run a **positive control** — the same probe against
a grant known to be live.

**✅ CLOSED 2026-08-19: `staff_clock_events` was the last permissive anon policy.**
It carried SELECT/INSERT/UPDATE all `USING (true)` — measured as `anon`,
`UPDATE staff_clock_events SET room_id = 'probe'` touched **1547 rows**, no WHERE
needed. The public anon key could rewrite `clock_in`/`clock_out` across the whole
payroll history, and the SELECT exposed every staff member's hours. FS24 called
this "same-day cross-staff tampering"; it was the entire table. Fixed by
`staff_clock_pin_gated_rpcs.sql`: three PIN-gated `SECURITY DEFINER` RPCs
(`staff_clock_status`/`staff_clock_in`/`staff_clock_out`, same shape as
`log_child_event`) replace the direct table ops in `clockin.html`, and the anon
SELECT/INSERT/UPDATE policies plus table grants are dropped. Verified live as
`anon` in a rolled-back transaction — see the open-queue section below for the
full test.

---

## Clock-in integrity — the geofence never worked (2026-08-14)

`clock_device_and_location_truth.sql`, **applied and verified 2026-08-14.**

**The geofence is enabled** in settings (300ft, alerts to mdo@) and
`clockin.html` does call `getCurrentPosition`. Yet **all 1,547 clock events from
2026-03-04 to 2026-08-14 carried a NULL coordinate and `outside_fence = false`.**
Two causes, both fixed:

1. The `getCurrentPosition` error callback resolved `outsideFence: false` — the
   value meaning *"we checked and they were on site."* A denied location
   permission was stored as a clean punch.
2. Both fence columns carried `DEFAULT false`, so omitting the column lied too.

Now: `outside_fence` is **NULL when unknown**, and `*_location_status` records
which kind of unknown (`ok`/`denied`/`timeout`/`unavailable`/`unsupported`/`off`/
`not_recorded`). The 1,547 historical rows were backfilled to NULL +
`not_recorded` — left alone they would have read as 100% compliant in the very
report built to measure compliance.

**Device id** (`clock_in_device_id` / `clock_out_device_id`) is a random UUID in
`localStorage`, minted per browser. Not a hardware fingerprint.
⚠️ **Clearing site data mints a new one, so a shared id is evidence and differing
ids prove nothing.** Never gate a clock-in on it — it is a report
(**Staff → Pay & Policy → Clock-In Integrity**, `full` role only), and it
deliberately blocks nobody. Device *binding* was considered and deferred: the
recovery burden lands on the director at 7am, and there was no evidence of buddy
punching to justify it — because location had never been recorded, so no
evidence could exist either way.

⚠️ **`staff_clock_events` grants LOOK per-column** in
`information_schema.column_privileges` (that view enumerates every column for a
table-level grant too). They are table-level. Verified the anon write path with
the new columns end to end as `anon`, rolled back, before shipping.

### ⚠️ Revoking a function from `PUBLIC` does not revoke it from `anon`

Supabase's default privileges grant EXECUTE on a new `public` function **directly
to `anon`**, so `REVOKE … FROM PUBLIC` leaves that grant standing. Caught here on
`review_staff_injury_report`, which came out anon-executable after a textbook
revoke. This is the R26/R27 trap inverted — there, revoking `anon` alone was
insufficient because of an inherited PUBLIC grant. **Revoke from both, then
verify with `has_function_privilege` rather than assuming.**

---

## Sixth sweep — full code review (2026-08-19, v2.5.x)

Whole codebase (~41k lines JS, 20 edge functions, 114 migrations, 17 HTML pages)
**plus live verification against the production catalog** (`dahdstopsumxnqvdclmy`)
and against the deployed edge-function list. Read-only: no code was changed.

Every claim below was checked against the live catalog or the deployed function
list, **not inferred from the docs** — which is how three of the "still open"
items in this file turned out to be closed already, and one closed item turned
out to have reopened on a new table.

---

### 🔴 NEW-1 — `admin_push_subscriptions` grants `anon` DELETE **and TRUNCATE**

**This is the 2026-08-14 TRUNCATE finding, reopened on a table created three days
after the sweep that closed it.**

```sql
select relacl from pg_class where relname = 'admin_push_subscriptions';
-- {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,...}   -- ← anon holds everything
select has_table_privilege('anon','admin_push_subscriptions','TRUNCATE');  -- true
```

It is the **only** table in the schema where `anon` holds DELETE or TRUNCATE —
verified by sweeping all tables with `has_table_privilege`. Every other table is
clean, and RLS is enabled on all of them.

- **DELETE is not exploitable.** The single policy is
  `"service role only" … USING (false)`, so a row-level statement matches nothing.
- **⚠️ TRUNCATE is.** TRUNCATE does not read rows, so **RLS never applies to it** —
  the grant alone is sufficient. Anyone holding the public anon key, which ships in
  the browser on every page, can erase every admin push subscription.
- **Impact is silence, which is why it would not be noticed.** The director stops
  receiving push for new parent messages and incidents. Nothing errors, no banner
  appears, and the fix requires every admin to re-subscribe from their own phone —
  after somebody first works out that the notifications stopped.

**Root cause — and it is a documented one.** `add_admin_push_subscriptions.sql`
creates the table, enables RLS and adds the `USING (false)` policy, but **never
revokes Supabase's default grants**, which hand `ALL` on any new `public` table
directly to `anon` and `authenticated`. Its own header comment says it "mirrors
`staff_push_subscriptions`" — and `staff_push_subscriptions` has no anon grant,
but only because the 2026-08-14 sweep stripped it later. The migration mirrored
the file, not the live state.

| | date |
|---|---|
| `anon_grant_sweep_2026-08-14.sql` — all 51 tables audited, "no DELETE/TRUNCATE left anywhere" | 2026-08-14 |
| `add_admin_push_subscriptions.sql` added (commit `7946a8f`) | **2026-08-17** |

⚠️ **`CREATE TABLE` + `ENABLE ROW LEVEL SECURITY` + a policy is not a closed table.**
Supabase's default privileges are applied at creation and are invisible in the
migration. Every new-table migration needs an explicit
`REVOKE ALL ON <table> FROM anon, PUBLIC;`, and the check is `relacl`, not
`pg_policies`. The sweep is not a one-time task — it has to run after any session
that adds a table.

### 🔴 NEW-2 — `send-schedule-change` is called on every Add-a-Day and **is not deployed**

`js/supabase.js:3668` invokes `send-schedule-change`. That slug is **absent from
the 20 deployed edge functions** (`list_edge_functions`, verified 2026-08-19);
the source exists only in `supabase/functions/`.

The single caller is the admin Add-a-Day modal (`js/admin/admin-calendar.js:1133`),
and it is wrapped in `try { … } catch (emailErr) { console.warn(…) }` — so:

- the care date is written, billing is recomputed, the audit entry is logged,
  the modal reports success and closes;
- **the parent is never emailed that their schedule changed or that a change fee
  was added**, and no admin has ever had a reason to notice.

The push notification fires on a separate path, so families with push enabled got
*a* notice — which is very likely why this has gone unreported. There is no email
record of any schedule change for the life of the feature.

⚠️ **Do not simply deploy it as-is.** Its body still carries `parentEmail`,
`existingDates`, `addedDate` and `changeFee` **from the browser** — the exact
pre-T1 shape that `send-schedule-confirmation` was rewritten to eliminate
(see T1 below, now closed). Deploying the current source would reintroduce
T1/FS6/FS11 on a new function: an arbitrary recipient with arbitrary figures.
Rewrite it to take registration ids and read everything server-side — the
`send-invoice` / `send-schedule-confirmation` posture — *then* deploy.

### 🟢 NEW-3 — an orphan edge function was deployed under the slug `dynamic-function` — CLOSED 2026-08-19

`list_edge_functions` returns 20 functions. One has slug **`dynamic-function`**
and name `send-staff-schedule`, and **has no source anywhere in this repo.** It is
an earlier deploy of the staff-schedule mailer that went out under Supabase's
default slug, was redeployed two days later under the correct name
(`send-staff-schedule`), and was never deleted. It is still `ACTIVE`, still
routable at `/functions/v1/dynamic-function`, and has never been updated since.

So there are two live copies of the same mailer, one of them invisible to this
repo — it will not be found by a grep, will not be patched when
`send-staff-schedule` is, and does not appear in any deploy checklist. Delete it,
and check the deployed slug list against `supabase/functions/` whenever a function
is deployed, because the dashboard's default slug does not match the folder name.

**Deleted 2026-08-19.** `list_edge_functions` now returns 19 functions — the
`dynamic-function` slug is gone, and `send-staff-schedule` (slug
`send-staff-schedule`, v4) is confirmed still `ACTIVE`. Deleted by hand in the
dashboard since the MCP server exposes no delete-function tool; verified
programmatically afterward rather than trusted from the dashboard UI.

### 🟠 NEW-4 — no `frame-ancestors`, no `nosniff`, no `Referrer-Policy`

`_headers` sets only `Strict-Transport-Security` and `Content-Security-Policy`
(`worker.js` matches it — they are in sync, see R25 below). Missing:

| Header | Consequence |
|---|---|
| `frame-ancestors` / `X-Frame-Options` | **`admin.html` can be framed by any origin — clickjacking** against the portal that manages children's records. ⚠️ `frame-ancestors` has **no fallback to `default-src`**, so the existing `default-src 'self'` does *not* cover this. The CSP's `frame-src` is the opposite direction (what this page may embed — the Maps iframe) and gives no protection here. |
| `X-Content-Type-Options: nosniff` | MIME sniffing on uploaded/served content. |
| `Referrer-Policy` | Full admin URLs leak in the `Referer` to `fonts.googleapis.com` and `cdn.jsdelivr.net`. |
| `Permissions-Policy` | Geolocation/camera/microphone are not restricted — the clock-in page legitimately uses geolocation, so scope rather than blanket-deny. |

`frame-ancestors 'self'` is the one worth doing first, and it must be added to
**both** `_headers` and `worker.js`.

### 🟡 NEW-5 — FS11 confirmed still open, and it is the last free-text mailer

`send-staff-schedule` calls `auth.getUser()` and returns 401 without a session —
but it checks **no admin role**, and takes `staffEmail`, `staffName` and `shifts`
straight from the request body (`index.ts:59`, `to: [staffEmail]` at `:169`).
Any signed-in admin at *any* level — including `restricted` and `staff`, whose
restrictions are browser-only (R20) — can send arbitrary content to an arbitrary
address from the center's domain. Supabase signups are disabled (S4), so the
population is admins rather than the internet, which is what keeps this at medium.

This is the FS6/FS11 shape. `send-invoice`, `send-schedule-confirmation` and the
worker's `/send-push` / `/send-staff-broadcast` have all been converted to
**send by reference** — ids in, recipient and text read server-side. These two
(`send-staff-schedule` and the undeployed `send-schedule-change`) are what remain.

### 🟡 NEW-6 — the most sensitive tables are gated at `is_admin()`, not by role

R20's browser-only role enforcement is **largely closed for money and wages** —
18 policies now call `admin_role()` server-side, covering `billing_*`,
`payroll_periods`, `staff`, `staff_hours`, `staff_pto_entries`, `family_rates`,
`church_staff*`, `cacfp_*`, `market_providers` and `admin_audit_log`. That is real
progress and it covers exactly the surface R20 named.

Two tables the UI treats as the *most* restricted did not come along:

```sql
staff_injury_reports  →  "admin only"     ALL  {authenticated}  USING (is_admin())
staff_clock_events    →  "admin any role" ALL  {authenticated}  USING (is_admin())
```

Both sit in `AP_FULL_ONLY_KEYS` (`staffInjury`, `clockIntegrity`), so the browser
hides them from `restricted` and `staff` — but the policy admits any admin. A
`staff`-role account can read, over the REST API, the injury reports that this
file describes as naming "an employee, their body, and where they were treated",
and the full clock history the geofence report is built from. These two should
move to `admin_role() = 'full'` to match their own UI gate.

### 🔵 Lower severity, noted not chased

- **`payroll_*` — an 11-function admin API reachable with the public anon key**,
  gated only by `private.check_payroll_secret(p_secret)`. It belongs to the church
  ChMS payroll app, not this repo (nothing here calls it; `payroll.html` is a
  mockup), but it is exposed on the same PostgREST endpoint and covers
  `payroll_save_staff`, `payroll_save_hours`, `payroll_approve_period` and
  `payroll_deactivate_staff`. There is no attempt log and no throttle on the
  secret. Worth confirming with whoever owns that app that the secret is long,
  rotated, and not in any client bundle.
- `prevent_duplicate_care_date` has a mutable `search_path` (the only such
  function; it is SECURITY INVOKER, so the risk is small). **Every SECURITY
  DEFINER function in the schema has `search_path` pinned** — verified.
- Supabase Auth's leaked-password protection (HaveIBeenPwned) is **off**. Admin
  logins are the only passwords in the system; turning it on is a dashboard toggle.
- `pg_trgm` is installed in the `public` schema.
- `parent_accounts`, `pin_reset_tokens` and `staff_clock_notifications` have RLS on
  with **no policy at all** — the advisor flags this as INFO, but it is deliberate
  and correct here: deny-all to everyone except the service role. Leave them.

---

### ✅ Flagged in earlier sweeps, verified **resolved** — stop carrying these

Checked against the live catalog and deployed functions, not against the doc.

| Item | Was | Now |
|---|---|---|
| **R24** registration window | "never applied; `P0001` handler in `app.js` can never fire" — stated as open in *both* this file and `CODE_REVIEW_2026-08.md` | **APPLIED.** `check_registration_window()` and the `enforce_registration_window` trigger both exist live. The window is enforced server-side and the handler works. |
| **T1** `send-schedule-confirmation` | no auth check, trusted client-supplied amounts; this file says it "still needs deploying" | **CLOSED and DEPLOYED** (v14, `verify_jwt=true`). Body carries `registrationIds` only; recipient, dates and every amount read server-side. |
| **R25** Google Fonts blocked by worker CSP | brand fonts silently falling back | **FIXED.** `worker.js` and `_headers` CSP are byte-for-byte in sync, both allow `fonts.googleapis.com` / `fonts.gstatic.com`. |
| **R17 / FS22** CSV formula injection | open | **CLOSED.** `csvCell()` prefixes `= + - @ TAB CR` and is applied to every user-controlled field across all 32 export sites — including the two exports that build rows inline (`admin-billing-report.js`, `admin-billing.js`), which I checked field by field. |
| **FS10** `admin-users` fails **open** on empty `admin_roles` | open | **CLOSED.** Parses defensively and fails **closed**; invalid JSON denies. |
| **R15** pinch-zoom blocked | `maximum-scale=1.0` on `clockin.html` | **FIXED.** Gone; only the explanatory comment remains. |
| **R16** no focus styling in admin | open | **FIXED.** 26 focus rules in `css/admin.css`. |
| **R20** roles enforced browser-only | open | **Largely closed** for the money/wage surface — 18 role-scoped policies. Residual is NEW-6 above. |
| **R5** audit log never recorded | table absent | **Recording.** 39 rows live. |
| **FS4** stored XSS via names in `onclick` | fixed | **Held.** Zero unescaped interpolations into any inline handler across `js/`. |
| **R9** everything `no-store` | ~1.5 MB re-downloaded per view | **Substantially fixed** — media `immutable`/1yr, `dist`+`css` `no-cache` (304, empty body), HTML `no-store`. See below for the half that remains. |
| **R10** render-blocking CDN | `xlsx` + `chart.js` blocking first paint | **Partly fixed** — both now carry `defer`. SRI still absent everywhere; `@supabase/supabase-js@2` is still an unpinned floating major on 14 pages. |
| `.insert().select()` trap | audited at 11 chains | **Re-audited: 15 chains, all safe.** The two on anon-INSERT tables (`families`, `students`) are admin-only paths and `authenticated` holds SELECT on both (checked with `has_table_privilege`). The new chains are all on `billing_*` / `cacfp_*`, which `anon` cannot INSERT at all. |
| Parent-session RPCs | — | **Well built.** `add_pickup_contact`, `remove_pickup_contact`, `set_my_notification_prefs` and `confirm_child_allergies` look unauthenticated from their signatures (no PIN, no id), but every one resolves the family from `my_parent_context()` → `auth.uid()`, and `remove_pickup_contact` puts `family_id` in the `WHERE` so another family's row simply does not match. Do not "fix" these by adding a caller id parameter — that would be the regression. |

Also healthy: `npm test` passes **161/161** including both drift guards, and
`npm run build` produces **no diff** — `dist/` is in sync with `js/`.

---

### Performance — R12 is the one that will actually break something

**R12 has gotten worse and now has a measurable ceiling.** `fetchAllRegistrations()`
is called from **22 sites** with no bounds (the one call passing
`sinceDate: '2000-01-01'` bounds nothing), and it fans out to:

| | at R12 (2026-08-02) | now (2026-08-19) |
|---|---|---|
| `registrations` | 552 | **608** |
| `registration_dates` | 5,502 | **6,081** |
| JSON per call | — | **923 kB** (measured) |

Growth is roughly **100 registrations a month** and nothing ages out. Two limits
to plan against, not one:

1. **PostgREST `db-max-rows`.** If it is the 1,000 default, truncation is about
   four months away — and it is **silent**: no error, just registrations missing
   from the admin calendar and the capacity overview. It is not set as a role-level
   override, so confirm the value in the project's API settings.
2. **`statement_timeout = 8s` on `authenticated`** (confirmed in `pg_roles`). This
   is the one that bites first and hardest, because it turns a slow dashboard into
   a failed one.

Every one of those 923 kB is also **parent name, email and phone for all 608
registrations, pulled into the browser on every admin page load** regardless of
which tool the director actually opened. A default month window would fix the
ceiling and shrink the PII footprint at the same time.

**The admin bundle grew 34% since R9 was written.**

| | at R9 | now |
|---|---|---|
| `dist/admin.min.js` | 611 KB | **816 KB** (207 KB gzipped) |

Admin critical path is ~**294 KB gzipped** (`admin.html` 29 + `admin.min.js` 207 +
`admin.css` 32 + `styles.css` 11 + `supabase.min.js` 18), before the CDN scripts
and before the 923 kB of registration JSON.

⚠️ **The remaining half of R9 is blocked on filenames, not on headers.** `dist/*`
is `no-cache` rather than `immutable` *because the bundles are not content-hashed*
— the HTML references `dist/admin.min.js` literally and the deploy has no build
step, so caching it hard would serve stale JS after a deploy. Every load is
therefore still a conditional request, and every deploy is a full 816 KB
re-download (which is every PR, since `npm run bump` changes the bundle). The fix
is a content hash or a `?v=` from `js/build-version.js` in `patchHtml`, which
would let `dist/*` go `immutable`. That is the largest remaining load-time win and
it carries no security cost.

**R11 is untouched:** 12 separate single-key `settings` queries
(`.eq('key', …)`) and **zero** uses of `.in('key', [...])`. `initDashboard()` still
fans out `loadRateSettings` / `loadRatioSettings` / `loadCapacitySettings` /
`loadOfferLinks` / `loadSummerCampSetting` / `loadGeofenceSettings` as separate
round-trips to the same table. One `.in()` replaces all six.

Minor: `admin-billing.js:788/902/1445` await `fetchBillingOverrides(month)` serially
inside a `for…of` over months — 12 sequential round-trips where `Promise.all` would
do one wave, plus an O(n×m) `families.find()` inside the per-family loop.

### Design consistency — R13 is moving the wrong way

| | at R13 (2026-08-02) | now |
|---|---|---|
| `alert()` | 163 | **198** |
| `confirm()` | — | **46** |
| `showToast()` | 25 | **51** |

Toast usage doubled, but blocking native dialogs grew faster, so the styled system
still covers only about a fifth of user feedback. The concentration is worth
knowing before anyone tries to fix it in one pass: `admin-reports.js` (54),
`admin-billing.js` (37) and `admin-families.js` (17) hold more than half of them.
`confirm()` is the harder half — replacing it needs a promise-based modal, not a
toast, and 46 call sites currently depend on its synchronous return value.

The rest of the design system is in good shape: `--green-text` (#3A7B60) is
correctly documented as the foreground-only token with `--green` reserved for
surfaces, and `a { color: var(--green-text) }` means R14's contrast fix is
applied at the root.

### ✅ Phase 0 applied 2026-08-19 (+ FS29, FS25)

| Code | State | Detail |
|---|---|---|
| **SX1** | **CLOSED** | `REVOKE ALL ON admin_push_subscriptions FROM anon, authenticated, PUBLIC`. Revoked from `authenticated` too — it also held TRUNCATE, and the table is reached only with the service role key (`worker.js` `/admin-push-subscribe`, `/send-push`, the 410 cleanup). Verified: anon DELETE/TRUNCATE false, authenticated TRUNCATE false, service_role unaffected. **Whole-schema sweep re-run: 0 tables where `anon` holds DELETE or TRUNCATE.** The revoke was also backfilled into `add_admin_push_subscriptions.sql` so replaying it is safe. |
| **SX4** | **CLOSED** | `frame-ancestors 'self'` + `nosniff` + `Referrer-Policy: strict-origin-when-cross-origin` + `Permissions-Policy: geolocation=(self), camera=(), microphone=(), payment=()`, added to **both** `_headers` and `worker.js`. Geolocation is scoped rather than denied because `clockin.html:764` calls `getCurrentPosition` for the geofence; nothing in the app uses `getUserMedia`, so camera/microphone are denied outright. CSP parity between the two files was checked directive-by-directive after the edit. |
| **SX9** | **CLOSED** | `prevent_duplicate_care_date()` search_path pinned to `public, pg_temp`. 0 functions in the schema now have a mutable search_path. |
| **SX11** | **CLOSED** | `pg_trgm` moved `public` → `extensions`. Verified safe first: **0 indexes** use trgm operator classes and the only functions referencing `similarity()`/`<->` are pg_trgm's own — nothing in this app uses it. ⚠️ If trigram search is ever wanted, our definer functions pin `search_path` to `public`/`public, pg_temp` and will not find `similarity()` in `extensions` without adding it. |
| **SX3** | **CLOSED 2026-08-19** | Deleted by hand in the dashboard (no delete-function tool available here). Verified: `list_edge_functions` now returns 19 functions, `dynamic-function` is gone, `send-staff-schedule` is still `ACTIVE`. |
| **SX10** | **OPEN — needs a hand** | Leaked-password protection is a dashboard auth setting with no API exposed here. Authentication → Providers → Email → "Prevent use of leaked passwords". |
| **FS29** | **CLOSED** | `daysSince` is now computed in `_buildArRows()` from `invoice.sent_at`. ⚠️ **The column will still read blank today, and that is correct**: all **515** invoices have `sent_at IS NULL` because nothing has ever been issued. It fills in as soon as the Invoices tool's *Email invoices* or *Mark sent* is used. Aging deliberately runs from `sent_at`, not the start of the month — an invoice nobody has sent is not overdue. |
| **FS25** | **CLOSED** | The success toast moved inside the `try`. A failed send now opens the `mailto:` fallback **without** also claiming the message was sent. |

### Punch list — everything unresolved as of 2026-08-19

> **Phase 0 is applied** — see the table just above. SX1, SX3, SX4, SX9, SX11,
> FS29 and FS25 are closed; SX10 needs a dashboard action. The rows below are
> otherwise unchanged.

Codes are stable: cite them in commits and PRs. `SX` = sixth sweep (this one).
Earlier prefixes keep their original meaning (`R` fifth, `FS` fourth, `T` third,
`SS` second, `S`/`U`/`V`/`P`/`M` first review).

**Verification status is part of each row and is not decoration.** Rows marked
🔬 were checked against the live catalog, the deployed function list or the
source this session. Rows marked 📄 are carried from the older docs and were
**not** re-checked — after R24, T1 and R22 all turned out to be closed while the
docs still called them open, a 📄 row should be re-verified before anyone spends
a day on it.

#### SX — sixth sweep (all 🔬 verified live)

| Code | Pri | Item | Fix |
|---|---|---|---|
| **SX1** | **P1** | `admin_push_subscriptions` grants `anon` DELETE **and TRUNCATE**. RLS never applies to TRUNCATE, so the public anon key can erase every admin push subscription. Only such table in the schema. | `REVOKE ALL ON admin_push_subscriptions FROM anon, PUBLIC;` — then add an explicit revoke to every new-table migration and re-run the `relacl` sweep. |
| **SX2** | **P1** | `send-schedule-change` is invoked on every admin Add-a-Day and **is not deployed**; the caller swallows it in a `console.warn`, so the day is booked and billed and the parent is never emailed. | Rewrite to take registration ids and read recipient/amounts server-side (the `send-invoice` posture), **then** deploy. Do not deploy the current source. |
| ~~**SX3**~~ | ~~P2~~ | ~~Orphan edge function live under slug `dynamic-function`~~ **CLOSED 2026-08-19** — deleted, verified via `list_edge_functions`. | Diff deployed slugs against `supabase/functions/` after every future deploy — the dashboard's default slug does not match the folder name. |
| **SX4** | P2 | No `frame-ancestors` / `X-Frame-Options` → `admin.html` is framable by any origin (clickjacking). Also missing `nosniff`, `Referrer-Policy`, `Permissions-Policy`. | Add `frame-ancestors 'self'` first. ⚠️ Must go in **both** `_headers` and `worker.js`; `frame-ancestors` has no fallback to `default-src`. |
| **SX5** | P3 | `send-staff-schedule` checks a session but **no admin role**, and takes `staffEmail` + content from the request body (FS11 residual; last free-text mailer). | Send by reference + require `admin_role() = 'full'`. |
| **SX6** | P3 | `staff_injury_reports` and `staff_clock_events` gate on `is_admin()` while their UI gates to `full` via `AP_FULL_ONLY_KEYS` (R20 residual). | Move both policies to `admin_role() = 'full'`. |
| **SX7** | P3 | `PRIVACY-AND-SECURITY-OVERVIEW.md` §3.3 now **understates** security: it still tells the reader the anon key can read the family and student tables. R1/R4 closed that. | Update §3.3 and §3.5 — a compliance document that describes a fixed hole is its own liability. |
| **SX8** | P4 | `payroll_*` — an 11-function admin API (save staff, save hours, approve period, deactivate staff) reachable with the public anon key, gated only by `private.check_payroll_secret()`. No throttle, no attempt log. Owned by the church ChMS app, not this repo. | Confirm with that app's owner that the secret is long, rotated, and absent from any client bundle. |
| **SX9** | P4 | `prevent_duplicate_care_date` has a mutable `search_path` — the only such function (SECURITY INVOKER, so low risk). | Pin it. |
| **SX10** | P4 | Supabase Auth leaked-password protection (HaveIBeenPwned) is off. | Dashboard toggle. |
| **SX11** | P4 | `pg_trgm` installed in the `public` schema. | Move to `extensions`. |
| **SX12** | P4 | `admin-billing.js:788/902/1445` await `fetchBillingOverrides(month)` serially in a `for…of`, plus an O(n×m) `families.find()` per family. | `Promise.all` the months; index families by email in a `Map`. |

#### Carried forward — 🔬 re-verified still open this session

| Code | Pri | Item | Note |
|---|---|---|---|
| **R12** | **P1** | `fetchAllRegistrations()` unbounded from **22** call sites. | Now **923 kB** of parent PII per call (608 regs / 6,081 dates), growing ~100 regs/month, against a **`statement_timeout = 8s`** on `authenticated`. The timeout bites before the PostgREST row ceiling. Add a default month window. |
| **R9** | P2 | Bundles still cannot be cached `immutable`. | Headers half is **done**; the blocker is that `dist/*` filenames are not content-hashed. Add a hash or a `?v=` from `js/build-version.js` in `patchHtml`. `admin.min.js` is now 816 KB (was 611 KB). |
| **R10** | P3 | No SRI on any CDN tag; `@supabase/supabase-js@2` is an unpinned floating major on 14 pages. | The blocking half is fixed — `xlsx` and `chart.js` now carry `defer`. |
| **R11** | P3 | 12 single-key `settings` queries, **zero** uses of `.in('key', [...])`. | One `.in()` replaces six round-trips in `initDashboard()`. |
| **R13** | P3 | `alert()` 163 → **198**, plus **46** `confirm()`, against `showToast()` 25 → **51**. | Moving the wrong way. Half sit in `admin-reports.js` (54), `admin-billing.js` (37), `admin-families.js` (17). The `confirm()` half needs a promise-based modal, not a toast. |
| **S6** | P3 | PIN-reset throttle is **per family, 15 minutes** — not the per-IP throttle this was raised for. | Still enumerable/abusable from many IPs against many families. |
| **FS23** | P4 | 5 `.ilike()` sites still pass user input with `%` / `_` unescaped. | |
| **R18** | P4 | `admin-reports.js` is **6,685** lines (was 5,910 when flagged). | Growing. |

#### 📄 Carried from the older docs — NOT re-verified this session

Listed so nothing is lost, **not** asserted as current. Re-verify before acting.

- **Fourth sweep:** FS7, FS8, FS9, FS12, FS13, FS14, FS15, FS16, FS17, FS18,
  FS19, FS20, FS21, FS25, FS26, FS27, FS28, FS29, FS30.
- **Third sweep:** T3, T4, T5, T6–T20.
- **Second sweep:** SS3, SS9, SS11, SS16, SS17, SS18, SS19.
- **First review:** S8 (anon-key rotation), U3, U4, V2–V6, P1–P3, M1.
- **Fifth sweep:** R21 (`family_login` leaks account existence).

#### Closed — do not re-open without re-checking the catalog first

🔬 verified closed this session: **R1, R4, R5, R7** (CI now runs `npm test` in a
`verify` job that the merge `needs:`), **R15, R16, R17/FS22, R22** (no
`.DS_Store` tracked), **R23, R24, R25, FS4, FS10, FS24, T1**, and the bulk of
**R20** (18 policies now gate on `admin_role()`). **R19** is addressed by this
sweep's edits to this file.


### Re-verification of every carried-forward item (2026-08-19)

The 📄 block below was resolved against source and the live catalog. **13 of the
44 items were already fixed** and had been carried as open, in some cases for a
year. Two looked fixed and are not. One has silently widened.

⚠️ **`daysSince` is the lesson of this pass.** FS29's CSV column reads
`r.daysSince != null ? String(r.daysSince) : ''` — which looks like a considered
null-guard, and is why it scanned as fixed. `daysSince` is never assigned
anywhere in the codebase, so the guard renders `''` every time. **A defensive
expression around a field is not evidence the field exists.** Grep for the
producer, not the consumer.

#### ✅ Verified fixed — closed, removed from the punch list

| Code | Evidence |
|---|---|
| **FS8** | `js/app.js:654-660` — the cross-parent name match is now a non-blocking `showToast` ("may already be registered… Verify before submitting"), exactly the recommended fix. Unrelated families sharing a child's name can both register. |
| **FS15** | `capacitySection` is in the `_resetRoleRestrictions()` array (`admin-core.js:170`), with a comment explaining why. |
| **FS17** | The `Math.max(0, …)` floor is gone; non-promised seating now does `working[target.id][mm][d] -= 1` (`admin-waitlist.js:635`), matching the promised path, so later-month overbooking surfaces. |
| **FS28** | `_recomputeInvoice()`'s catch now raises an error toast — "Day saved, but the invoice could not be recalculated" (`admin-calendar.js:672-678`). No longer swallowed. |
| **T5** | `waitlist-status` reads ages and capacities live from `settings` (`room_rates` / `room_capacity`) and merges them over the defaults. The hard-coded numbers are fallbacks, not the source of truth. |
| **T9** | `--theirs` is no longer blind: it is scoped to `dist/*.min.js` build artifacts, and the version conflict resolves to `sort -V | tail -1` (the **higher** version) rather than whichever side won. |
| **T16** | `offered_days` is read by the allocator (`admin-waitlist.js:568, 627`), not just written. |
| **T18** | `file.name.replace(/[^a-zA-Z0-9._-]/g, '_')` (`admin-settings.js:133`). |
| **SS9** | `submit_registration(jsonb)` does both inserts in one transaction — no orphaned `registrations` row is possible. |
| **SS11** | **Fully closed and well built.** `verify_staff_pin()` does per-account lockout (5 tries → 15 min), an IP throttle *and* a global backstop, and a correct PIN clears the counter so old fumbles cannot accumulate. The IP comes from `pin_client_ip()` server-side, never a parameter. ⚠️ A literal grep for `pin_attempts_blocked` in `staff_id_for_pin` returns nothing and reads as unprotected — it **delegates** to `verify_staff_pin`, so all 21 PIN-gated RPCs inherit the throttle. Check the call chain, not the function body. |
| **SS17** | Superseded. The `work_date = CURRENT_DATE` anon clock-out policy no longer exists — `staff_clock_pin_gated_rpcs.sql` dropped the anon policies entirely. |
| **P4** | `escHtml` is a single `/[&<>"']/g` pass against `_ESC_HTML_MAP`. |
| **V2** | ~300 inline `style=` attributes → **50** (index 23, calendar 24, lookup 3). |

#### ❌ Verified still open

| Code | Evidence |
|---|---|
| **FS7** | `js/app.js:709-716` pre-populates every matching weekday with `{dayType:'full', locked:true}` and **no** check against `closureMap`, capacity or `today`. A recurring Monday on a holiday is still force-booked, billed, and unremovable. |
| **FS9** | `js/lookup.js:61` is still `/^\d{4}$/`. A parent with a 5–8 digit PIN logs in on `index.html` and cannot log in on `lookup.html`. One-character fix. |
| **FS12** | `_normalizeImportDate` (`admin-billing.js:2358-2363`) still does `new Date(raw)` first, so an ISO date lands a day early in Central time and an Excel serial silently becomes today. |
| **FS13** | `_calcYtdPeriods` (`admin-reports.js:1734-1741`) still counts every 14-day period from Jan 1; there is no `hire_date` anywhere in the file. |
| **FS14** | Narrowed but open. `applyRoleRestrictions()` now also hides finance, cacfp, market and `auditLogSection` — but `restricted` still sees **Families (full PII, PINs, discounts), Billing, Reports and Messages**, and `staffDirectorySection` / `geofenceSection` / `enrollmentFormsSection` / `enrollmentCapacitySection`. |
| **FS16** | `wlpEnrollFromWaitlist` prompts for a missing phone but passes `parentEmail: k.parentEmail` straight through with no check (`admin-waitlist.js:1828`). |
| **FS18** | `wlpOpenOfferModal()` is defined at `admin-waitlist.js:1838` and **called from nowhere** — the only other mention is a comment. Still unreachable dead code. |
| **FS20** | The in-modal edit path calls `renderTable(allRegistrations)` (`admin-calendar.js:487`), not `applyFilters()`, so the list re-renders unfiltered and unsorted. |
| **FS21** | ⚠️ **Widened.** The CREATE branch of `saveFamilyModal()` (`admin-families.js:1075-1085`) passes only name/dob/room/discount to `addStudent()`. The UPDATE branch passes `recurring_days`, `allergies`, `care_notes` and `photo_release` — the create branch drops all four. **`allergies` is now among them**, so a child added at family-creation time starts with no allergy record and no `allergies_reviewed_at`. That is a safety field, not a convenience field. ⚠️ **Severity corrected 2026-08-19:** measured live, **0 of 150 students** were created through this path (no student row shares a creation minute with its family row) and **0 have `allergies_reviewed_at IS NULL`** — the update branch stamps it, and every family has been edited at least once. So the defect is real in the code and has not bitten anyone yet: latent, not active. Fix it before the path is used, but no backfill is owed. The first write-up escalated this from the code alone without checking whether the path had ever run — the same mistake as FS29 in the opposite direction. |
| **FS23** | 5 `.ilike()` sites still pass `%` / `_` unescaped. |
| **FS25** | The catch now falls back to `mailto:`, but `wlsToast` (success) is still shown unconditionally after the `try/catch` (`waitlist-status.js:116-117`) — so a failure shows a mail client *and* "sent". |
| **FS27** | Month nav clears `_arPickDate` and hides the picker only (`admin-calendar.js:1385-1396`); accumulated selections from the previous month survive. |
| **FS29** | Open, and disguised. See the ⚠️ note above — `daysSince` has no producer. |
| **FS30** | `reports: { icon: '📊', label: 'Billing' }` in `TAB_META` (`admin-settings.js:321`) — two tabs both read "Billing". |
| **T13** | `${{ github.ref_name }}` is still interpolated directly into `run:` blocks (`auto-merge-claude.yml:62, 91`). |
| **T15** | `auth.includes(serviceRoleKey)` (`send-waitlist-reminders/index.ts:37`) — still a substring match. |
| **T17** | No `status = 'cancelled'` filter in `wlpBaseBooked()`. Dormant while cancellation hard-deletes. |
| **T19** | `admin-classrooms.js:309` renders `${roomLabel}` raw in the `<h3>` while **line 311 of the same template** wraps it in `escHtml()`. |
| **T20** | Structurally open — the suite still exercises hand-maintained copies (`business-logic.test.js:523`). **Materially mitigated**: the source-drift and cross-file guards re-read the real sources and fail CI on divergence, so the copies cannot drift silently. Priority drops accordingly. |
| **SS3** | `submit_registration` contains no capacity check (verified against the live function body). Oversubscription is still only prevented in the browser. |
| **SS16** | `login_attempts` resets on success or admin unlock, never on elapsed time. |
| **SS18** | `cleanup_pin_reset_tokens()` exists but **`pg_cron` is not installed**, so nothing ever calls it. |
| **S6** | `request-pin-reset` has no IP throttle and does not call `pin_attempts_blocked`. |
| **R21** | `family_login` still returns `login_locked` / `registration_locked` and the `parent2_*` block (S7's over-return, and the existence oracle behind R21). |
| **M1** | `js/supabase.js` 2,497 → **4,721** lines. |
| **U3** | Partial — `:disabled` rules exist in a handful of components (15 across both stylesheets), but there is no shared spinner/loading state. |
| **U4** | Breakpoints still inconsistent: 520, 600, 640, 700, 860, 900px all in use. |
| **V4** | `:root` palette still duplicated in `index.html`, `enroll.html`, `clockin.html`. |
| **V5** | `.btn-secondary` defined 4× in `styles.css` and 4× in `admin.css`. |
| **V6** | No typography scale. |
| **P1** | `renderCalendar()` still does per-cell `cal.appendChild(el)` (`app.js:848, 855`). |
| **P2** | `getChildDayAmounts()` still recomputed per call site (`app.js:1282, 1313`), unmemoized. |
| **P3** | Per-cell capacity lookups uncached. |

#### 🆕 SX13 — families get a weaker login defense than staff, and the parts to fix it already exist

Found while re-verifying SS11/SS16. The two PIN systems are not equally defended:

| | per-account lockout | IP throttle | global backstop |
|---|---|---|---|
| `verify_staff_pin` (staff) | ✅ 5 tries → 15 min | ✅ | ✅ |
| `family_login` (parents) | ✅ `login_attempts` / `login_locked` | ❌ | ❌ |

`pin_attempts_blocked()` and `record_pin_attempt()` are already written, already
`SECURITY DEFINER`, already deriving the IP server-side — `family_login` simply
does not call them. Neither does `request-pin-reset` (**S6**). So a parent PIN
can be walked across many accounts at full speed, and the per-account counter
never decays (**SS16**) so it only ever locks the legitimate parent out.

SX13, S6 and SS16 are one fix, not three: call the existing throttle from
`family_login` and `request-pin-reset`, and decay `login_attempts` on elapsed
time the way `verify_staff_pin` clears on success.

#### Not re-verified — needs product judgment, not a catalog query

These are policy or numeric-correctness questions that cannot be settled by
grep, and each needs the director in the room: **T4** (admin vs parent waitlist
position), **T6** (ProCare import dedup), **T7** (weekly-rate days in the per-day
preview), **T8** (sibling discount dropped), **T10** (waitlist-status PII rate
limit), **T11** (allocation logic duplicated in the edge function), **T12** (DOB
month off-by-one), **SS19** (weekly discount on partial weeks), **S8** (anon-key
rotation), **V3** (palette consolidation).


### Proposed phased work plan (drafted 2026-08-19)

Sequenced so that each phase is independently shippable and nothing later
depends on a decision that has not been made yet. Phases 0–2 are unambiguous
engineering; phase 3 onward needs the director's input on at least one item.

**Two sequencing rules, both learned the hard way here:**

1. **Grants before behavior.** SX1 is a live data-destruction grant. It is one
   `REVOKE` and it should not wait behind a sprint of UI work.
2. **Never run two `claude/**` branches over shared files.** `js/supabase.js`,
   `admin.html` and `dist/` are touched by most phases below. Land them in
   order, syncing with `main` between each, or repeat the silent-revert that
   already cost this repo a `supabase.js` line.

---

#### Phase 0 — Same day. Stop the bleeding. (~1 hour)

No product decisions, no UI, no regression surface worth speaking of.

| Item | Work |
|---|---|
| **SX1** | `REVOKE ALL ON admin_push_subscriptions FROM anon, PUBLIC;` Then re-run the `relacl` sweep across all tables to confirm it is the only one, and add the revoke to `add_admin_push_subscriptions.sql` so a replay of the migration is safe. |
| **SX4** | Add `frame-ancestors 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and a scoped `Permissions-Policy` to **both** `_headers` and `worker.js`. ⚠️ Test with the `Service-Worker-Allowed` header technique — a CSP that looks right in `_headers` proves nothing about what the Worker serves. |
| **SX9, SX10, SX11** | Pin `prevent_duplicate_care_date`'s `search_path`; turn on leaked-password protection; move `pg_trgm` out of `public`. |
| ~~**SX3**~~ | ~~Delete the `dynamic-function` edge function.~~ **Done 2026-08-19.** |

**Exit check:** `relacl` sweep clean on all tables; `curl -I` shows the four new
headers on `/` **and** on `/admin.html`; deployed slug list matches
`supabase/functions/` exactly.

#### Phase 1 — This week. The two silent failures. (~1 day)

Both are cases where the app reports success and something real does not happen.

| Item | Work |
|---|---|
| **SX2** | Rewrite `send-schedule-change` to take registration ids and read recipient, dates, amounts and the change fee server-side — copy `send-schedule-confirmation`'s shape exactly. Deploy it. Then **stop swallowing the failure** in `admin-calendar.js:1141`: a change notice that did not send should toast like `_recomputeInvoice` now does. ⚠️ Do not deploy the current source; it would reintroduce T1 on a new function. |
| **FS29** | Compute `daysSince` in `_buildArRows` (from `invoice.sent_at`, per the AR aging rule already documented for `add_invoice_send_stamp.sql`) — or delete the column. A permanently blank column is worse than no column. |
| **FS25** | Move the success toast inside the `try`, so the `mailto:` fallback does not also claim the message was sent. |

**Exit check:** add a day on a test family and confirm the email arrives; export
the AR CSV and confirm the column has numbers.

#### Phase 2 — Next. One migration closes four findings. (~1 day)

**SX13 + S6 + SS16 + R21/S7 are a single piece of work.** The throttle already
exists and is already correct; it is simply not called on the family side.

- Call `pin_attempts_blocked()` / `record_pin_attempt()` from `family_login` and
  from `request-pin-reset`.
- Decay `login_attempts` on elapsed time, mirroring how `verify_staff_pin`
  clears on success — today the counter only ever locks out the real parent.
- While in that function, trim `family_login`'s projection (drop
  `registration_locked` and the unused `parent2_*` fields) — that is R21/S7, and
  it is a two-line change once the function is already open.

Also in this phase, because they are one-liners in files nobody else is touching:

| **FS9** | `/^\d{4}$/` → `/^\d{4,8}$/` in `lookup.js`, plus the label text. Parents with a 6-digit PIN currently cannot use that page at all. |
| **T19** | Wrap `roomLabel` in `escHtml()` at `admin-classrooms.js:309`. |
| **T15** | `auth === \`Bearer ${key}\``. |
| **FS30** | `reports` label → "Reports". |
| **SS18** | Either install `pg_cron` and schedule `cleanup_pin_reset_tokens()`, or make it opportunistic the way `record_pin_attempt` prunes (~1% of calls) and drop the cron idea entirely. The second is less infrastructure. |

**Exit check:** live rolled-back test as `anon` — wrong family PIN 10× from one
IP returns throttled; a 6-digit PIN logs in on `lookup.html`.

#### Phase 3 — The data-integrity set. (~2–3 days, one decision needed)

| Item | Note |
|---|---|
| **FS21** | ⚠️ **Treat as the priority of this phase.** Pass `recurringDays`, `allergies`, `careNotes`, `photoRelease` in the CREATE branch of `saveFamilyModal()`. Allergies silently not saving on a newly created child is a safety defect, not a Medium bug. Then backfill: find children created through that path with `allergies_reviewed_at IS NULL` and have the office confirm them. |
| **FS7** | Skip closed, past and full dates when pre-populating recurring days, and let a locked day be removed. Currently a holiday Monday is force-booked and billed. |
| **FS16** | Validate `parentEmail` in `wlpEnrollFromWaitlist` the way phone already is. |
| **FS12** | Parse `^\d{4}-\d{2}-\d{2}$` as local (`+'T00:00:00'`) and handle Excel serials explicitly. |
| **SS3** | Enforce capacity inside `submit_registration`. It already owns the transaction, so this is where it belongs. **Decision needed:** hard-reject an over-capacity submission, or auto-waitlist the overflow day? The second matches what the admin planner already assumes. |
| **FS20, FS27** | Re-render through `applyFilters()`; clear accumulated selections on month nav. |

#### Phase 4 — Performance. (~2–3 days, biggest user-visible win)

Do **R12 first** — it is the one with a clock on it.

1. **R12.** Give `fetchAllRegistrations()` a default month window and page beyond
   it explicitly. 22 call sites, so land it as one change with a shared default
   rather than per-caller. This removes ~923 kB per admin load and takes the
   8s `statement_timeout` risk off the table. It also shrinks the PII footprint,
   which is worth stating in the compliance doc afterward.
2. **R9 (remaining half).** Emit a content hash or a `?v=` from
   `js/build-version.js` in `patchHtml`, then serve `dist/*` `immutable`.
   Currently every deploy re-downloads 816 KB.
3. **R11.** One `.in('key', [...])` for the six settings loads in `initDashboard`.
4. **R10.** Pin `@supabase/supabase-js` to an exact version and add SRI to all 16
   CDN tags.
5. **SX12, P1, P2, P3.** `Promise.all` the month loop; build the calendar in one
   fragment; memoize `getChildDayAmounts`.

**Exit check:** admin dashboard cold-load transfer and time-to-interactive,
before and after, recorded in the PR.

#### Phase 5 — Access control hardening. (~1–2 days)

| **SX6** | Move `staff_injury_reports` and `staff_clock_events` to `admin_role() = 'full'`, matching their own UI gate. |
| **SX5** | Convert `send-staff-schedule` to send-by-reference and require `full`. This retires the last free-text mailer. |
| **FS14** | Hide Families, Billing, Reports, Messages and the four Settings sub-sections from `restricted`. ⚠️ Browser-side only — it is the *rule set* being wrong, distinct from SX6. |
| **SX7** | Confirm the `payroll_*` shared secret with the ChMS owner. Not this repo's code, but it is on this repo's PostgREST endpoint. |

#### Phase 6 — Cleanup, no urgency

**FS13** (label the salaried YTD an estimate, or add `hire_date` — the label is
the honest cheap fix), **FS18** (delete the dead offer flow or wire it up —
decide which), **FS23**, **T13**, **T17**, **T20**, **M1**, **R18**, **U3**,
**U4**, **V4**, **V5**, **V6**.

**R13 deserves its own scoped pass**, not a slot in a cleanup list: 198 `alert()`
and 46 `confirm()`. The `confirm()` half needs a promise-based modal before a
single call site can move, and 54 of the alerts are in `admin-reports.js` alone.
Do the modal first, convert one file per PR, and treat it as UI work with a
reviewer — a find-and-replace across 244 call sites is how a confirm-guard gets
dropped on a delete button.

#### Still needs the director, before anything above depends on it

**T4** (whose waitlist "position" is the real one — the parent's per-room number
or the admin's global one), **T8** (should the sibling discount survive the case
that currently drops it), **SS19** (weekly discount on a closure-shortened week),
**T6** (what counts as a duplicate payment import), **FS18** (is the formal
email-offer flow wanted at all). Each changes what money a family owes or what
the office tells them on the phone, so none should be settled from the code.


### Nothing found in these

Checked and clean, recorded so the next sweep can skip them: no committed secrets
(the only key in the tree is the public anon key, which is expected and is behind
RLS); no unescaped interpolation into any inline event handler; every SECURITY
DEFINER function has `search_path` pinned; RLS is enabled on every table in the
schema; `dist/` in sync; 161/161 tests green.

---

## ⚠️ Current open queue — start here (updated 2026-08-03, v2.3.23 — see the sixth sweep above for what has since closed)

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

**SETTLED 2026-08-12 — the public waitlist form was broken, and is now fixed.**
- `submitWaitlistApplication()` chained `.insert().select()`, anon had **no SELECT
  policy** on `waitlist_applications`, and RLS applies SELECT policies to `RETURNING`.
  Proven as the `anon` role in a rolled-back transaction: the insert **succeeds without
  `RETURNING` and fails with it** (`42501`), so the whole statement would abort and
  nothing be written.
- ⚠️ **No applications were actually lost — an earlier note here said otherwise and was
  wrong.** `pg_stat_statements` (complete since 2026-03-10, zero evictions) shows the
  `anon` role has **never** issued a single query against `waitlist_applications`. All 49
  rows were written by an authenticated admin: **47 within one minute on 2026-07-03** (a
  bulk import) plus one each on 07-10 and 07-11, entered by hand. Zero have
  `confirmation_sent_at`. The "month-long gap" is not lost submissions — it is a form
  nobody uses.
- **The real gap is discoverability, not the bug.** `inquiry.html` is linked from exactly
  one place: the marketing site (`marketing/website/index.html`). Nothing on the portal
  links to it, yet `index.html`'s own FAQ tells parents to "join the online waitlist
  through the care day portal." Inquiries arrive by phone/email and the office types
  them in. (`messages`, the Contact Us table, is the same story — 1–3 a month, none
  since July.)
- Fixed by `fix_public_waitlist_submit.sql` (**applied 2026-08-12**): a
  `submit_waitlist_application(jsonb)` SECURITY DEFINER RPC returning only `id` and
  `applied_at`. **Not** fixed with an anon SELECT policy — that would have exposed all
  37 columns of every family's entry (the R27 class of mistake). The RPC takes an
  explicit column allow-list, verified by injection test: a payload carrying
  `status:'offered'`, `paperwork_received:true`, `deposit_paid:true` and a backdated
  `applied_at` stored `pending / false / false / now()`.
- ⚠️ **Any anon `.insert().select()` is suspect for the same reason.** RLS applies
  SELECT policies to `RETURNING`, so an insert that works alone fails the moment a
  `.select()` is chained. Check before adding one.

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

**R1 / R4 anon-grant remainder — CLOSED, verified live 2026-08-19.** The two bullets that
stood here (claiming `anon` could still read `registrations`/`registration_dates`/`staff`,
and still held SELECT/INSERT/UPDATE on `staff_clock_events`) were stale — re-checked
against `information_schema.role_table_grants` and `pg_policies` directly rather than
trusted from the doc, per the R5/R24 lesson below:

- `registrations` / `registration_dates` — `anon` holds **INSERT only**, no SELECT policy
  at all. This was **not** `ss1_public_read_rpcs.sql` (that file's functions don't exist
  live) — the actual fix routed the client through `registration_conflict()` and
  `capacity_counts()`, two other anon-executable RPCs already wired into
  `checkExistingRegistration()`/`checkExistingRegistrationByChild()`/
  `fetchCapacityForDates()` in `js/supabase.js`. `ss1_public_read_rpcs.sql` can be deleted
  or left as dead groundwork — nothing depends on it.
- `staff` — `anon` SELECT is `USING (active = true)` plus an explicit 6-column grant
  (`id, name, role, room_id, active, has_staff_pin` — no wages, no PIN hash). This is the
  R26 fix (2026-08-03), already documented above; the "still open" bullet here was
  describing a state that hadn't been true for two weeks.
- `staff_clock_events` — **fixed this session.** `staff_clock_pin_gated_rpcs.sql` applied
  and verified live (rolled-back end-to-end test as `anon`: wrong PIN → NULL, correct PIN
  → status/clock-in/clock-out all succeed, double clock-in blocked by the SS12 unique
  index with a friendly message, closing another staff id's event blocked, direct
  `SELECT`/`UPDATE` on the table confirmed `permission denied`). The kiosk
  (`clockin.html`) now calls `staff_clock_status` / `staff_clock_in` / `staff_clock_out` —
  all PIN-gated `SECURITY DEFINER`, same `staff_id_for_pin()` helper as
  `log_child_event`/`staff_my_schedule` — and the `anon select/insert/update clock events`
  policies plus the raw table grants are dropped. This was the **last** fully-permissive
  (`USING (true)`) anon policy on the schema.

**Still open — unrelated to anon table grants:**
- ~~**R24** — the registration window is **not** enforced server-side.~~ **CLOSED —
  re-verified live 2026-08-19:** `check_registration_window()` and the
  `enforce_registration_window` trigger both exist in production. See the sixth sweep.
- **R20** — `restricted`/`staff` admin roles are enforced only in the browser.
  **Largely closed 2026-08-19** — 18 policies now gate on `admin_role()` server-side,
  covering billing, payroll, wages and the audit log. Residual: `staff_injury_reports`
  and `staff_clock_events` are still `is_admin()` only while their UI gates to `full`
  (sixth sweep, NEW-6).

**Migration reconciliation (2026-08-02, updated 2026-08-19).** All files in
`supabase/migrations/` were diffed against the live catalog. `add_audit_log.sql` was
superseded and applied as `add_audit_log_hardened.sql`. `enforce_registration_window.sql`
(R24) is **now applied** — re-checked against `pg_proc`/`pg_trigger` 2026-08-19, both the
function and the trigger exist, so nothing is left unapplied.
⚠️ But this diff no longer covers everything: it compares *files* to the catalog and so
cannot see a table whose **grants** drifted. `admin_push_subscriptions` was created
2026-08-17 with Supabase's default `anon` grants intact and this reconciliation did not
flag it (sixth sweep, NEW-1). Re-run the `relacl` sweep too, not just the file diff.
`ss1_public_read_rpcs.sql` is now known
**dead** — R1's registrations/registration_dates SELECT was independently closed via
`registration_conflict()`/`capacity_counts()` (see above), so this file's functions were
never deployed and nothing calls them. `staff_clock_pin_gated_rpcs.sql`
(**applied 2026-08-19**) is new. Everything else is applied, including
`add_staff_time_off_requests.sql` and `add_invoice_send_stamp.sql` (both 2026-08-11).
**Re-run this diff after any migration work — a committed migration is not a deployed
one, and that is exactly how R5 and R24 hid.** Also: a fix landing without a matching doc
update is exactly how the R1/R4 bullets above went stale for two weeks — update this file
in the same session as the migration, not after.

**Updated 2026-08-11:** `add_staff_time_off_requests.sql` was written **and applied**
in the same session (admin portal redesign — the kiosk→director time-off flow).
Verified post-apply: `anon` holds zero table grants and is denied SELECT/INSERT,
RLS is on with a single `authenticated` policy, both RPCs are `SECURITY DEFINER`
with pinned `search_path`, and an end-to-end submit/list round trip through the
`anon` role stores the correct staff uuid and weekday.

**Updated 2026-08-14:** `staff_injury_and_headcount.sql` was written **and
applied** in the same session (see the Safety & compliance section above).
Verified post-apply end to end in a rolled-back transaction: the PIN gate returns
`NULL` on all three RPCs, `attendance_status` correctly reports a checked-in-then-
out child as `left`, a future `occurred_at` is clamped, and a `log_fire_drill`
payload carrying `drill_date: '1999-01-01'` and a forged conductor stored today's
date and the PIN holder. `anon` has zero table grants on either new table.

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
  `request-pin-reset`); ~~FS24 anon UPDATE on `staff_clock_events` allows same-day
  cross-staff tampering~~ **fixed 2026-08-19**, see the RLS section above; FS25
  waitlist "Message the Office" shows success toast on
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
- ~~**`send-schedule-confirmation`** edge fn still needs deploying.~~ **DEPLOYED and
  T1-fixed** (v14, verified against the live function list 2026-08-19): the body carries
  registration ids only. ⚠️ The genuinely undeployed one is **`send-schedule-change`**,
  which the Add-a-Day modal calls on every use and which fails silently — see the sixth
  sweep, NEW-2, and do not deploy it in its current client-trusting shape.

### Hard-won operational notes (don't repeat these)
- **`supabase/migrations/` is NOT auto-applied** — run migrations by hand in the SQL
  Editor. A committed migration ≠ a deployed one. Confirm a new RPC/column exists
  (`pg_proc` / `information_schema.columns`) before deploying code that needs it.
- **Auth/billing/RLS changes:** stage + smoke-test (parent login, kiosk, a test
  registration, admin tabs) before prod.
- **Don't run two `claude/**` branches editing shared files at once** — that caused a
  silent revert of a `supabase.js` line and the version-conflict merge failures. Sync
  with `main` before pushing.
- **⚠️ The MCP `execute_sql` tool does not share session/transaction state across
  `;`-separated statements in one call, at least not reliably** — `set_config(...,
  true)` (or even `false`) in one statement was invisible to `admin_role()` in the
  next statement of the *same* call, including inside an explicit `BEGIN … ROLLBACK`
  block. A test built that way silently inserted a real row (the RPC's own guard
  returned early on what looked like a failed impersonation, but the surrounding
  `BEGIN`/insert/`ROLLBACK` shape masked that nothing had actually rolled back what
  a *different*, earlier statement in the chain had committed) and it sat live in
  `incident_reports` for the rest of the session before being found and deleted.
  **Do the whole impersonate-and-call sequence in ONE `SELECT`** (a `WITH cfg AS
  (SELECT set_config(...))` CTE feeding the RPC call in the same statement, as this
  file's own applied-migration verification blocks now do) — never split
  `set_config` from the call it's meant to gate across separate statements, and
  never trust "the result looked like null/failure" as proof nothing was written.
  Re-query the table afterward to be sure, every time.

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
clockin.html        Staff clock-in/out. ⚠️ NOT a kiosk despite the name used
                    throughout this repo — staff clock in on their OWN phones.
                    There is no shared device anywhere in the center. Any
                    security reasoning that rests on "it's a shared wall
                    device" is wrong; see staff_contact_details_APPLIED.sql.
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
| `staff_injury_reports` | Employee work injuries (workers' comp). Admin-only, **no parent policy, ever**; no DELETE for anyone |
| `fire_drills` | One row per drill, with the roster snapshot taken at the time. Admin-read, written by a PIN-gated RPC; no DELETE |
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

### Approving a payroll period for the church's combined reader (2026-08-20)

The church admin app (`timothystl/website`, `admin.timothystl.org/payroll`) combines
this app's staff/hours with its own church staff into one biweekly report, reading
MDO data over a set of `payroll_get_mdo_*` RPCs (see that repo's CLAUDE.md,
"Payroll & Supabase"). It had a period-approval concept of its own
(`payroll_periods`, one row per period_start, written from that screen) but nothing
that let *this* app's director say "I've reviewed my staff's hours for this period"
independently of whatever the church side has done.

**"Approve MDO Payroll"** on the Staff → Payroll report screen (`admin.html` /
`js/admin/admin-reports.js`) writes to a new `mdo_payroll_approvals` table
(`period_start` PK, `approved_at`, `approved_by`) — a **separate fact** from the
website's `payroll_periods`, never merged with it. The button is visible only to
`full`-role admins, matching the tool's own `AP_FULL_ONLY_KEYS` gate, and RLS on
the table is `admin_role() = 'full'` — no anon grant at all, the corrected pattern
NEW-6/SX6 elsewhere in this file argues for on payroll-adjacent tables.

- **Written directly by this app** (`fetchMdoPayrollApproval` /
  `approveMdoPayrollPeriod` / `unapproveMdoPayrollPeriod` in `js/supabase.js`) —
  this app has its own Supabase Auth session, so unlike the website's `/sb/`
  proxy there is no shared secret involved on this side.
- **Read by the website** through a new `payroll_get_mdo_period_approval(p_secret,
  p_period_start)` RPC, the same shared-secret-gated shape as the other
  `payroll_get_mdo_*` functions — `anon` holds `EXECUTE` on it and nothing else,
  and it is `SECURITY DEFINER` with `search_path` pinned like its siblings.
- **`period_start` has to line up with the website's own biweekly boundaries** —
  both sides already agree on them, since `payroll_get_mdo_hours`/
  `payroll_get_mdo_clock_events` are already queried by the same start/end a
  church period uses.
- **Deliberately two independent approvals.** Approving here does not touch, gate,
  or require the website's own `payroll_periods` approval, and vice versa —
  neither app should assume anything about the other's decision.

### Registration window
The window is defined by the `registration_window` setting. `app.js` gates the UI on it
and has a handler for the `P0001` error a database trigger would raise.

> **✅ ENFORCED SERVER-SIDE — R24 closed, verified live 2026-08-19.**
> `enforce_registration_window.sql` **has been applied**: both `check_registration_window()`
> and the `enforce_registration_window` trigger exist in production (checked against
> `pg_proc` / `pg_trigger`). The `P0001` handler in `app.js` can now fire, and a direct
> POST to the REST API outside the window is rejected by the database rather than only by
> client-side JavaScript.
>
> ⚠️ **This note previously said the opposite**, and stayed wrong long enough to be quoted
> as open in `docs/CODE_REVIEW_2026-08.md` too. R24 was originally *found* by re-checking
> the catalog instead of trusting this file; it was *closed* the same way. Re-verify
> against `pg_proc`/`pg_trigger` before citing either state.

---

## Environment / secrets

Set as Cloudflare Pages environment variables and Supabase Edge Function secrets:
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` — injected into HTML at build time or via `_headers`
- `SUPABASE_SERVICE_ROLE_KEY` — used by edge functions only (never exposed to browser)
- `VAPID_PRIVATE_KEY` (JWK) / `VAPID_PUBLIC_KEY` / `VAPID_SUBJECT` — **wrangler
  secrets on the Worker**, not edge function secrets. Web push is served by
  `worker.js`, not by anything in `supabase/functions/`. Mint with
  `scripts/generate-vapid-keys.js`; the public key is also pasted into
  `js/push-notifications.js` and `js/staff/staff-push.js`.
- `FINANCE_API_KEY` — shared secret for the `finance-summary` edge function (see below); same value must be set as `DAYCARE_API_KEY` on the ChMS side
- `STAX_API_KEY` / `STAX_ENVIRONMENT` — Stax (fattmerchant) Core API bearer key, server-side only, never sent to the browser — see below
- `STAX_WEB_PAYMENTS_TOKEN` — the SEPARATE client-safe token Stax.js/Bolt needs in the browser (Stax dashboard → Settings → Web Payments); NOT the same value as `STAX_API_KEY`, see below
- `STAX_WEBHOOK_SECRET` — a value **we choose**, embedded as a `?secret=` query param on the webhook URL registered with Stax. Stax has no signing scheme of its own; see below.

---

## Stax payment processor — embedded checkout built, awaiting a real browser test (2026-08-26)

The center is evaluating Stax alongside the already-live Authorize.net integration
(`create-payment-session` / `authorizenet-webhook` / `admin-refund-payment` /
`reconcile-anet-payments`) — **both stay in place; this is not a replacement.**
Nothing about the Anet flow changed in this session.

**Was blocked on Stax's side, now cleared.** Earlier the same day, `GET /merchant/{id}`
for the sandbox merchant (`15904290-f3c8-4c6d-8d4d-fd2a953ce869`) returned
`gateways: []`, `gateway_type: null`, `vendor_keys: null`, `activated_at: null` and
`POST /payment-method` failed every time with `{"errors":{"vaultLookup":["Failed to
determine vault vendor for merchant account"]}}`. Support was emailed; their
activations team attached a test gateway the same day. Re-checked live:
`gateway_type` is now `"TEST"` and `gateways` is non-empty.

**Full server-side flow verified against the real sandbox, end to end:**
`POST /customer` → `POST /payment-method` (vaulted the documented test Visa
`4111 1111 1111 1111` against that customer, no more `vaultLookup` error) →
`POST /charge` (`{payment_method_id, customer_id, total, pre_auth, meta}`) → got back
`{"success": true, "id": "...", "status": "SUCCESS", ...}`. That is exactly the request
shape `charge-stax-payment` sends and the response fields it reads — **no code changes
were needed**, the scaffolding written blind against the API reference turned out
correct.

**Scaffolding is in place** (`create-stax-charge`, `charge-stax-payment`,
`stax-webhook` in `supabase/functions/`, plus `add_stax_payment_tracking.sql` adding
`families.stax_customer_id`). It mirrors the Authorize.net posture exactly — request
body carries only an invoice id, the amount charged is always recomputed server-side
from `billing_invoices`/`billing_payments`, ownership is checked via
`parent_family_ids()`, and raw card data is meant to never reach this server (Stax.js/
Bolt tokenizes client-side into a `payment_method` id, same PCI-SAQ-A goal as Accept
Hosted). `billing_payments.processor`/`processor_transaction_id` are already
processor-agnostic (added for Anet), so Stax payments just use `processor = 'stax'` —
no new payment-table columns needed.

### Embedded checkout — built this session, not yet run in a real browser

`portal-billing.js` now has a second payment flow (`pbStartStaxPayment` onward) that
embeds Stax.js/Bolt directly, instead of a hosted-page redirect: the card-number and
CVV fields are Stax's own tiny iframes, mounted into `#pbStaxCardNumber` /
`#pbStaxCardCvv` — divs **this app owns**, inside a modal (`#pbStaxModal` in
`portal.html`) styled with the portal's own design tokens. Everything except those two
fields — the layout, the amount shown, the Pay button, the receipt email that follows —
is this app's own, not Stax's. That is the actual point of comparing the two: not just
"does Stax work" but "do we get more control over how it looks and what the receipt
says" — Authorize.net's Accept Hosted page is Anet's own document inside an iframe we
don't control the inside of; Stax.js is the opposite shape.

- **Hidden from every real family by default.** `pbStaxTestEnabled()` only turns the
  second "Pay … with Stax (test)" button on when `?staxtest=1` was on the URL this tab
  loaded with (then sticks in `sessionStorage` for the tab). No admin role, no settings
  row — a normal parent visiting `portal.html` never sees it. This is deliberate: the
  auto-merge workflow (`.github/workflows/auto-merge-claude.yml`) puts every push to a
  `claude/**` branch straight into production, so a payment-flow comparison built for
  internal evaluation must not be reachable by a real family who has no reason to be
  asked "which processor?" A person running the evaluation adds `?staxtest=1` once on
  their own account/invoice.
- **A real bug was caught and fixed while building this.** The `create-stax-charge`
  scaffolding from earlier returned `staxPublicKey: apiKey` — literally the server-side
  `STAX_API_KEY` bearer key — to the browser. Stax's own docs confirm the browser needs
  a *separate* client-safe token ("Website Payments Token", from the Stax dashboard,
  Settings → Web Payments) for Stax.js, distinct from the Core API bearer key. Fixed:
  the function now reads a new secret, `STAX_WEB_PAYMENTS_TOKEN`, and returns that
  instead. Never reintroduce the old shape.
- **Receipts now match Anet's, on purpose.** `charge-stax-payment` sends the identical
  branded HTML receipt `authorizenet-webhook` sends (same Resend secrets, same
  template) — a family paying by Stax should see the same-looking receipt as one paying
  by Authorize.net, not a Stax-branded one. Fires only on a genuinely new charge record
  (never the idempotent-duplicate retry path), same rule as the Anet one.
- **Card-field mount config, expiration handling, and the `.tokenize()` call are all
  written from Stax's own documented code samples**
  (`docs.staxpayments.com/docs/accepting-credit-card-payments-on-your-website`,
  `/docs/tokenizing-a-credit-card`) — number/CVV are mounted iframes, expiration
  month/year travel as plain (non-tokenized) fields in the `.tokenize()` call, per
  Stax's own sample. **None of this has run in an actual browser.** This session has no
  way to obtain a real `STAX_WEB_PAYMENTS_TOKEN` (dashboard-only) to test against —
  only the server-side Core API calls (customer/payment-method/charge, done via curl)
  were verified live. Before this is anything but an internal comparison tool: set
  `STAX_WEB_PAYMENTS_TOKEN`, open `portal.html?staxtest=1` on a real test family
  account, and click through an actual card entry.
- ~~`stax-webhook`'s signature/auth scheme is still an unconfirmed placeholder~~ —
  **resolved and verified live 2026-08-27, see the section below.** It only matters
  for refunds/disputes; the charge path above doesn't depend on it.

**Historical test result, not a security approval:** real sandbox calls established
the request/response shape, but did not prove concurrency safety, atomic recording,
webhook authenticity, or launch readiness. The 2026-08-27 hardening migration and
function rewrites supersede the earlier "verified sound" wording. Treat the flow as
internal-only until those changes are deployed in order and tested.

**Production gate (2026-08-27):** both parent Stax endpoints require
`STAX_PAYMENTS_ENABLED=true` **and** `STAX_ENVIRONMENT=production`. This is
intentional: the previously documented credentials belong to a sandbox/test
merchant, and a sandbox approval must never be recorded as a real tuition payment.

### Deployed and live-tested (2026-08-26)

`create-stax-charge` and `charge-stax-payment` were deployed to Supabase (they only
existed as committed source before), `add_stax_payment_tracking.sql` was applied
(`families.stax_customer_id` now exists live), and both secrets
(`STAX_API_KEY`/`STAX_WEB_PAYMENTS_TOKEN`) were set. First real click-through against
`portal.html?staxtest=1` (a throwaway test family, `$5.00` test invoice) got both
payment buttons rendering correctly, but clicking "Pay with Stax (test)" failed
immediately with **"Could not load the Stax payment library."**

⚠️ **The cause was this repo's own CSP, not Stax.** `_headers`' `script-src` only
allowed `cdn.jsdelivr.net` / `static.cloudflareinsights.com` — `staxjs.staxpayments.com`
was never on the allowlist, so the browser silently blocked the `<script>` tag
`pbLoadStaxJs()` injects. Same story as R25 (Google Fonts) and the home-page Maps
embed: a `frame-src`/`script-src` miss looks identical to a real bug from the JS side,
and only the CSP tells them apart. Fixed in **both** `_headers` and `worker.js`
(verified byte-identical after editing, per this file's standing rule) by adding:
- `script-src`: `https://staxjs.staxpayments.com` (loads the library itself)
- `connect-src`: `https://apiprod.fattlabs.com`, `https://fattqueryprod.fattlabs.com`,
  `https://transactions.fattlabs.com` — read directly out of `staxjs-captcha.js`'s own
  bundled source (`grep`'d for `fattlabs.com`/`fattmerchant.com` references) rather than
  guessed from docs, so this list is exactly what the library itself calls.
- `frame-src`: `https://staxjs.staxpayments.com`, `https://omni.fattmerchant.com` — the
  two candidate hosts for the mounted card-number/CVV iframes; `omni.fattmerchant.com`
  is confirmed live (it's the `merchant_location_descriptor` in the `/charge` response
  verified earlier this session), `staxjs.staxpayments.com` added defensively since the
  library is loaded from there.

**Re-tested — the script-load fix worked, and surfaced a second, separate CSP miss.**
The modal now renders with the app's own styling (badge, title, amount, layout) instead
of erroring immediately, confirming `staxjs.staxpayments.com` was the only problem with
the *outer* library. But the card-number/CVV fields themselves rendered as a
refused-iframe placeholder — a blank gray box with a broken-page icon, Chrome's tell for
"this iframe embed was blocked," not a missing-image icon.

⚠️ **The actual vaulting host is `core.spreedly.com`, not a Stax-branded domain at
all.** Stax.js loads Spreedly's own hosted-fields library
(`core.spreedly.com/iframe/iframe-v1.min.js`) to collect the card number and CVV —
found by grepping `staxjs-captcha.js`'s bundled source for `spreedly`, since nothing in
Stax's own docs names this. Added to `script-src`, `connect-src`, and `frame-src` in
both `_headers` and `worker.js` (re-verified byte-identical after editing). This is the
lesson to keep: a third-party embedded-payments library can itself depend on a further
third party for the actual sensitive-field vaulting, and that dependency has to be
found by reading the library's own bundle, not by trusting its documentation.

**Re-tested — Spreedly wasn't even the real problem.** The card fields still failed the
same way ("flash of what might be real fields, then reverts to a blocked placeholder"),
but this time the browser console was captured directly, and it told the actual story
`core.spreedly.com` never could:

```
Vendor lookup complete: using BlockChyp
Failed to execute 'postMessage' on 'DOMWindow': The target origin provided
('https://test.blockchyp.com') does not match the recipient window's origin ('null').
```

⚠️ **Stax.js bundles support for several possible vault backends (BlockChyp, Spreedly,
NMI, Spreedly-adjacent others), and which one a given merchant's gateway actually uses
is a runtime fact, not something readable from the library's source or from Stax's
docs.** `core.spreedly.com` was a reasonable-looking find from grepping the bundle, and
it was even real — it's genuinely one of the vendors Stax.js supports — it just is not
the one *this* merchant's TEST gateway happens to route through. The iframe's real
target was `https://test.blockchyp.com`; blocked by `frame-src`, it never navigated
there and stayed at origin `'null'`, which is exactly why `postMessage` to it failed
and why the field visually "flashed" (Chrome briefly shows the frame shell) before
reverting to the blocked-content placeholder.

A secondary finding from the same console capture: Stax.js also unconditionally loads
Google's reCAPTCHA (`www.google.com/recaptcha/api.js`) for fraud prevention, also
blocked by `script-src` (handled gracefully by the library so far, but still a real CSP
violation worth fixing).

Added `https://test.blockchyp.com` + `https://api.blockchyp.com` to `frame-src` and
`connect-src`, and `https://www.google.com` to `script-src`, in both `_headers` and
`worker.js` (re-verified byte-identical). Left the Spreedly entries in place — harmless
if unused, and this vendor selection could plausibly differ for another environment
this project runs in.

**The real lesson: for a vendored library whose actual runtime behavior depends on
server-side merchant configuration, static analysis of its bundle can only ever
propose candidates — the definitive host list has to come from watching a live
browser session actually attempt the flow.** Two fixes based on reading the bundle
both missed; the one based on the browser console got it in one. Still not re-tested
after this third fix.

### Billing rollup, itemization, saved cards, and a verified refund webhook (2026-08-27)

- **Prior-balance rollup.** `create-payment-session` (Authorize.net) and
  `create-stax-charge`/`charge-stax-payment` (Stax) now charge the anchor invoice's own
  balance **plus** any still-unpaid earlier month, not just the one invoice a parent
  opened. `computeFamilyDueSet()` builds the oldest-first list of unpaid, *issued*
  (`sent_at` set) invoices through the anchor month; `allocateAcrossDueSet()` /
  `allocateAcrossPaymentRows` (webhook side) spreads one settled payment across all of
  them, capping each at that invoice's own remaining balance. Each function duplicates
  this pair rather than sharing a module — this repo's edge functions have no shared
  import path between them.
- **Itemized invoices, both processors.** `compute_family_month_charges_itemized()`
  (new SQL function, `add_family_month_charges_itemized.sql`) is the *exact same* CTE
  chain as `compute_family_month_charges()`, stopped one step earlier to return one row
  per child instead of a single total — so itemization can never drift from the real
  bill. Verified against real production families: the itemized sum matches the
  aggregate total exactly, including a family with an active discount. Authorize.net
  gets real `lineItem` entries on the Hosted Payment Page; Stax gets a `lineItems`
  array for the app's own modal to render (not yet wired into the visible portal UI).
- **PCI-compliant saved cards (Stax only so far).** `add_stax_saved_card.sql` adds
  `families.stax_default_payment_method_id` / `_card_last_four` / `_card_brand` — only
  Stax's own opaque vault reference plus the two PCI-permitted display fields, never
  card data. `charge-stax-payment` accepts `useSavedCard` (charge the card on file) and
  `saveCard` (remember a fresh one).

⚠️ **The rollup introduced a real bug, found and fixed the same session.** Splitting
one charge across several invoices suffixes each `billing_payments` row's
`processor_transaction_id` with `-inv<id>`, so a refund/void webhook naming the *bare*
original transaction id matched zero rows — a refund of a rolled-up charge would
silently fail to record. Both webhooks now use `findOriginalPaymentRows()` (matches the
bare id OR any `<id>-inv*` suffix) and reverse every row a charge was split into,
oldest-invoice-first.

### ✅ `stax-webhook` is real now — verified against a live registered webhook, not docs

Three iterations, each corrected by an actual delivery rather than more reading:

1. First draft (this file, pre-2026-08-27): a placeholder `X-Stax-Webhook-Secret`
   header and a guess at a `refund`/`void` event name with a nested
   `child_transactions[]` shape. **Never deployed against a real webhook.**
2. Read Stax's actual API reference (`docs.staxpayments.com/reference/*`): the webhook
   resource has no `secret` field at all — `{id, user_id, merchant_id, reference_id,
   url, event, created_at, updated_at, deleted_at}` — and creation takes only
   `target_url` + `event`. Stax's own doc: "you can generate a secret key in your URL
   ... to add additional security" — **the secret is a query param WE embed in the
   registered URL, not anything Stax computes or signs.** Rewrote to check
   `?secret=` on the incoming request instead of a header. Registered for
   `update_transaction` per the refund/void endpoint docs describing a "child
   transaction added to the parent." **This event never fired, for a charge, a
   refund, or a second refund — tested live, zero deliveries.**
3. Registered for `create_transaction` instead: fired within ~1 second for a real
   charge, and fired again for a refund of that same charge. **A refund/void delivers
   as its own `create_transaction` event** — Stax treats a reversal as a new
   transaction being created, not the parent being updated — and the POSTed body is
   that reversal transaction directly (top-level `type: "refund"`/`"void"`,
   `reference_id` = the original charge's id, `total` = the amount), not nested under
   a parent's `child_transactions[]` the way the refund *endpoint response* shape
   (used only by the earlier drafts) had suggested.

**The delivery shape was verified live**, not just inferred: charged a real test invoice via
the Core API, inserted the matching `billing_payments` row, issued a real sandbox
refund, and confirmed `stax-webhook` recorded the correct negative row
(`refund_of_payment_id` set, amount matching) and left the invoice status correct.
Test rows removed afterward — the live production catalog carries no trace of this
test. That test did not prove authenticity or atomic multi-row recording: the old
implementation trusted the webhook payload after only a URL-secret check and wrote
split reversals sequentially. The hardened webhook now re-fetches the transaction
from Stax's authenticated API and calls one transactional database function.

🚨 **Launch blocker: `stax-webhook-admin-tmp` remains deployed** to
register the webhook and drive these tests via Stax's Core API (gated by a hardcoded
token, not a project secret, precisely because it was meant to be short-lived). **It
must be deleted from the Supabase dashboard.** The repository includes an inert 410
replacement as an emergency containment step, but the live function must be disabled
or deleted and its hardcoded token treated as compromised before launch.
⚠️ Still true as of the fixes below — confirmed still `ACTIVE` in `list_edge_functions`,
still needs a human to delete it from the dashboard (no MCP delete-function tool exists).

### External payments security review — fixes applied 2026-08-28

A second AI agent's independent security review of the Stax work above was checked
claim-by-claim against the live catalog rather than taken on faith (several of its
"live evidence" claims were verified with direct queries before acting on them).
Two of its findings were real and fixable without a production/Stax go-live decision;
those were fixed this session. The two findings that require an actual production
Stax merchant (pinning/verifying the merchant id behind `STAX_API_KEY`, and running a
real `create_transaction` webhook test against production) were correctly identified
by the review as pre-launch gates, not live incidents — `charge-stax-payment` already
refuses to run unless `STAX_ENVIRONMENT === "production"`, which it is not yet, so
there was nothing to fix today. Revisit those two before any real Stax launch.

- **`add_day_to_invoice_by_email` was executable by every `authenticated` session,
  including a parent.** `fs5_phase1_revoke_add_day_anon.sql` (2026-08-11) revoked
  `anon`/`PUBLIC` and clamped the delta non-negative, but left `authenticated` with
  EXECUTE. That was fine while every `authenticated` caller was an admin; it stopped
  being fine the same day this repo shipped `parent_portal_option_b_accounts_APPLIED.sql`
  — parents now hold real Supabase Auth JWTs too. The function still takes an arbitrary
  `p_email` (not the caller's own family), has no admin-role check, and no status guard
  (writes to a `finalized`/`paid` invoice same as a `draft`). A signed-in parent could
  have called it directly against PostgREST to inflate any other family's issued
  invoice. **Not Stax-specific and needed no launch decision** — fixed immediately by
  `20260828030000_revoke_add_day_invoice_authenticated.sql`, which revokes
  `authenticated` too (service_role only now). Safe because `js/`/`supabase/` have zero
  remaining `.rpc('add_day_to_invoice_by_email')` call sites (superseded by the
  recompute-only billing rewrite the same day as the original fix) and
  `pg_stat_statements` still shows the same 30 historical `authenticated` calls
  `fs5_phase1` recorded in 2026-08-11 — zero calls since. Verified post-apply:
  `has_function_privilege` authenticated=false, anon=false, service_role=true.
- **Leftover sandbox test data was live in production**, exactly as the review's "live
  evidence" claimed and contrary to this file's own "no live trace" note (which
  describes a *different*, later webhook test, not this one): a synthetic family
  (`stax-eval-test@timothystl.org`, zero students), its `stax_customer_id`, a `$5.00`
  `billing_invoices` row, and the matching `billing_payments` row from the 2026-08-26
  first click-through — with no `payment_charge_locks` row, confirming it predated the
  hardening. All four deleted; verified zero remaining rows referencing that family or
  that Stax customer/payment.
- **A Stax `PENDING` charge (HTTP 202) was silently shown to the parent as a plain
  failure.** 202 is a 2xx status, so `supabase-js`'s `functions.invoke()` resolves it as
  `data`, not `error` — `chargeStaxPayment()` in `js/supabase.js` just returned the body,
  and `portal-billing.js`'s `chargeResult.success !== true` check discarded the server's
  real `{error: "...still processing...", ambiguous: true}` message in favor of a
  hardcoded `'Payment was not confirmed. Please try again.'`. The charge-lock already
  prevented a double charge; the parent was just told the wrong thing and had no reason
  not to retry immediately. Fixed by making `chargeStaxPayment()` recognize this shape
  and throw the server's own message (both portal-billing.js call sites already surface
  `e.message`, so no UI-layer change was needed). Guarded by a new test:
  `'client never reads a Stax PENDING (HTTP 202) response as a confirmed charge'`.
- **Migration history had drifted from what was actually applied** — the review found
  the live catalog recorded `harden_stax_payments` as
  `20260827225514_harden_stax_payments`, while the repo had it committed as
  `20260827193636_harden_stax_payments.sql`. Content was diffed against the live
  function bodies first and matched exactly (`stax_prepare_charge` etc.) — this was pure
  filename/history drift, not a functional gap. Renamed to match the applied version,
  per this file's own standing rule that a migration's filename should match what
  actually ran.
- **Not fixed, and don't try to fix from the code alone:** pinning/verifying the Stax
  merchant id, and a production `create_transaction` webhook test. Both need a live
  production Stax merchant, which does not exist yet — see the launch-blocker note
  above and the "Production gate" note earlier in this section.

`npm test` — 183/183 (added the one new guard above). `npm run build` — `dist/`
rebuilt; `dist/supabase.min.js` grepped for `Your payment could not be confirmed` to
confirm the fix actually shipped in the bundle portal.html loads, per this file's own
"it shipped half-live for a day" lesson.

### Second-round follow-up review — reconciliation job added, two items scoped out (2026-08-28)

A follow-up pass from the same external reviewer re-checked the fixes above and raised
four more items. One was newly built; two are documented, correctly-identified gaps
this session did not attempt; one is a migration-history footnote.

- **High — production webhook still unverified.** Same as the merchant-id pinning gap
  above: needs an actual production Stax merchant, which does not exist yet. Nothing to
  fix in code. Revisit together with that item before any real Stax launch.
- **Medium — no scheduled Stax reconciliation job — FIXED.** New function
  `reconcile-stax-payments` (deployed) + `schedule_stax_reconciliation.sql` (applied,
  runs every 30 minutes via the same pg_cron + pg_net pattern as
  `schedule_anet_reconciliation.sql`). It finds `payment_charge_locks` rows stuck
  `pending`/`ambiguous` for more than 15 minutes with no webhook confirmation — the
  exact gap the review named: `payment_charge_locks_active_family_idx` blocks that
  family from paying online again until something resolves the lock.
  - ⚠️ **Written defensively because it is itself unverified against a live merchant.**
    Stax's documented `GET /transaction` list/filter endpoint is used ONLY to find
    candidate transaction ids for a family's customer id in a time window — nothing
    from that response is ever trusted for a decision. Every candidate is re-fetched
    through `GET /transaction/{id}`, the exact same single-transaction call
    `stax-webhook` already verifies real production data through, and only that
    response's own `success`/`meta` fields decide anything. If the list endpoint's
    filters don't behave as documented, the worst case is zero candidates found and
    the existing gap simply persists one more cycle — nothing is corrupted, because
    `stax_set_charge_state()` itself already refuses to downgrade a lock once recorded
    `processor_succeeded`. Smoke-tested once against production (zero stale locks
    existed, so it returned `{candidates:0,repaired:0,released:0}` and logged one
    `admin_audit_log` row) — that confirms it deploys and runs cleanly, **not** that
    the list endpoint's filters actually work; watch the first real recovery closely.
  - A lock still unmatched after 2 hours (`RELEASE_HOURS`) is marked `failed` — not in
    the blocking set — so a family whose charge attempt genuinely never reached Stax
    (a network failure before Stax received it) is not locked out indefinitely by this
    job's own caution.
  - Reuses `stax_set_charge_state`/`stax_finalize_charge` — the exact same RPCs
    `charge-stax-payment` and `stax-webhook` already call. No new billing logic.
- **Medium — CSP still allows `unsafe-inline`/`unsafe-eval` — scoped out, not a
  same-session fix.** Confirmed still true, and confirmed why it isn't a quick
  tightening: this app has 431+ inline `style="..."` attributes across the HTML alone
  (many more are generated by JS template-literal rendering, e.g. every admin table
  row), 17 inline `<script>` blocks across `admin.html`/`index.html`/`portal.html`/
  `staff.html`/`clockin.html` used for build-time config injection, and at least one
  CDN library (`xlsx`, per R10) that may depend on `unsafe-eval`. Removing either
  safely needs either converting all of that markup away from inline styles/scripts,
  or a per-request nonce — which this static, no-build-step deploy
  (`assets.directory "."`, see the Development workflow section) cannot generate,
  since a nonce has to be unique per response and nothing here renders HTML per
  request except the narrow `run_worker_first` SSR path for `/`. Tightening this is a
  real, multi-page refactor that needs its own scoped session with a reviewer, the
  same call this file already made for R13's `alert()`/`confirm()` cleanup — not
  something to fold into a security-fix pass blind.
  ⚠️ **Half of this turned out wrong on closer inventory — see "CSP tightening" below
  (2026-08-28).** `script-src`'s `unsafe-inline`/`unsafe-eval` were removed the same
  day: only 23 inline event-handler attributes existed repo-wide (not "every admin
  table row" — that estimate was actually describing `style-src`'s inline `style="..."`
  attributes, a different directive), and neither CDN library nor this app's own code
  uses `eval`/`new Function`. `style-src`'s `unsafe-inline` genuinely does stay, for
  the reason given here — the multi-page refactor call was right for that half.
- **Low — `stax-webhook-admin-tmp` and `debug-list-webhooks` remain deployed as inert
  stubs.** Re-confirmed both are still the safe 410 stubs (not the original dangerous
  code) via `get_edge_function` — no live exposure — but both are still `ACTIVE` and
  still need a human to delete them from the Supabase dashboard; there is no
  delete-function tool available in this session, same limitation noted when SX3 was
  closed by hand earlier in this file.
- **Low — the new revoke migration drifted too.** Same class as `harden_stax_payments`:
  `apply_migration` assigns its own timestamp at apply time regardless of what the
  local filename says, so `20260828030000_revoke_add_day_invoice_authenticated.sql`
  never matched the live `20260828135150`. Renamed to match. **Lesson for next time:**
  re-check `list_migrations` immediately after every `apply_migration` call and name
  the local file from that result, not from a timestamp picked while drafting it —
  this is now the second time in one day this exact drift happened.

`npm test` — 188/188 (5 new guards for the reconciliation job). `npm run build` —
`dist/` rebuilt.

### CSP tightening — script-src locked to a hash allowlist (2026-08-28)

The second review round scoped this out as "a real, multi-page refactor, not a
safe blind fix" — and that was the right call for `style-src` (see below), but
`script-src`'s `unsafe-inline`/`unsafe-eval` turned out to be far more
tractable once actually inventoried instead of estimated. Removed both.

**Inline event-handler attributes: 23 total, not "every admin table row."**
`onclick=`/`onchange=`/`oninput=`/`onblur=`/`onkeydown=` across the whole
repo — `js/admin/admin-billing.js` (11, all in the Accounts Receivable table:
lock/unlock, edit-billed, Details, Payment, and the payment-history Refund
button), one each in `admin-reports.js` (a per-room collapse toggle),
`admin-finance-hub.js` and `admin-billing-report.js` (both a bare
`event.stopPropagation()` — dead code, verified no ancestor click listener
existed for either to guard against, so removed outright rather than
converted), plus 9 in `payroll.html` (a church-ChMS mockup — "nothing here
calls it," per this file's Stax section — but still served statically at
`/payroll.html` under the same global `_headers` CSP, so still had to be
fixed) and one in `docs/manual.html` (a print button — found only by the new
drift-guard test below; a root-only file scan had missed it, see that test's
own comment). All converted to `data-*` attributes plus a **delegated**
listener on the nearest container that survives every re-render — the
existing pattern this codebase already used in a few spots (e.g.
`admin-billing.js`'s own `.inv-adj-issue`/`.inv-adj-discard` buttons), just
not yet applied to the AR table.

⚠️ **A duplicate-handler bug was caught and fixed before shipping.** The
first pass added a delegated `.pay-hist-refund-btn` listener on
`#arTableWrap` in `setupBilling()` *and* left the direct
`el.querySelectorAll('.pay-hist-refund-btn').forEach(...)` binding already
sitting in `renderPaymentHistory()` — since that container always renders
inside `#arTableWrap` (a detail row opened from the AR table), a refund
click would have fired `refundOnlinePayment()` twice. Removed the direct
binding; the delegated one covers it.

⚠️ **`blur` doesn't bubble.** The "type a new billed amount" input's old
`onblur="saveBilledAmount(...)"` needed a bubbling equivalent to delegate
correctly — used `focusout` (fires in the same cases `blur` does, but
bubbles), not a capture-phase `blur` listener.

**Inline `<script>` blocks: 22 unique, locked to `'sha256-...'` hashes
instead of `'unsafe-inline'`.** Verified none are build-time templated —
`scripts/build.js`'s `patchHtml()` only replaces `<script src="js/...">` dev
tags with `dist/*.min.js` references; it never touches inline `<script>`
content, confirmed by reading the function, not assumed. So a hash computed
from the committed source is exactly what a browser hashes at request time,
stable across every future `npm run build`.

⚠️ **The first hash-generation pass only scanned root-level `.html` files —
missed 5 real pages.** `wrangler.jsonc` serves `assets.directory: "."`, and
`.assetsignore`'s own header comment says it plainly: "everything NOT listed
here is public on the live site." `docs/manual.html`, `marketing/email.html`,
`marketing/poster.html`, `marketing/website/index.html`, and the two
`docs/design_handoff/*.dc.html` mockups are all real, publicly-servable
files under the same global CSP — a root-only `fs.readdirSync('.')` scan
silently missed all of them, which is exactly how `docs/manual.html`'s own
`onclick="printPartB()"` almost shipped unconverted (caught only because the
new drift-guard test below walks the whole tree and failed on it). Both the
hash generation and the test that verifies it now walk the full repo,
respecting the same ignore list as `.assetsignore`.

**`unsafe-eval`: removed, based on evidence, not assumption.** Grepped this
app's own `js/` for `eval(`/`new Function(` — zero matches (the two
sub-strings in `js/tests/business-logic.test.js` are the Node test runner's
own `eval` calls, never shipped to a browser). Downloaded and grepped the
actual CDN bundles: `xlsx@0.18.5` and `chart.js@4.4.4` — zero
eval/`new Function` calls in either. `staxjs-captcha.js`, Spreedly's
`iframe-v1.min.js`, and Google's `recaptcha__en.js` (all loaded by the
gated, not-yet-production `?staxtest=1` flow) each contain a `new Function`
or `eval` call, but every one checked is the same well-known
`globalThis`-detection bundler-polyfill fallback (`n=n||new
Function("return this")()`, guarded by a `typeof globalThis`/`typeof
self`/try-catch chain ahead of it) or a legacy `JSON.parse`-unavailable
shim — dead code in any modern browser, which is why reCAPTCHA is
extensively deployed on sites with strict `script-src` and no
`unsafe-eval`. ⚠️ Not proven by executing the code, only by reading it — if
Stax's flow is ever exercised for real (the existing `?staxtest=1`
browser-verification TODO elsewhere in this file), watch the console
specifically for "Refused to evaluate a string as JavaScript" as the
tell-tale sign this reasoning was wrong for this specific bundle version.

**`style-src`'s `unsafe-inline` was measured, not just estimated, and stays
for now.** 758 `style="..."` occurrences in `js/*.js` alone (49 confirmed
dynamic — built with a template-literal `${...}` directly in the attribute
value), on top of 431+ static ones in the `.html` files themselves
(CLAUDE.md's earlier count). `'unsafe-hashes'` only allowlists an *exact*
attribute string, so it cannot cover a value that's different on every
render (a computed percentage, a data-driven color) — the only real fix for
those is converting every such call site to `el.style.propertyName = value`
(individual CSSOM property assignment, which CSP's `style-src` has never
restricted, unlike `.style.cssText =` or `setAttribute('style', ...)` —
confirmed only 2 of those exist in `js/`, both easy, but they don't unlock
anything on their own while everything else still needs `'unsafe-inline'`).
Converting hundreds of render functions across most of the admin surface is
a genuinely different scale of change from the 23 event handlers above, and
this session did not attempt it.

**New drift guards** (`js/tests/business-logic.test.js`, describe block "CSP
tightening"): script-src carries neither unsafe keyword; every inline
`<script>` block across the whole repo tree has a matching hash (fails loud
if someone edits a script's content without recomputing it — the "shipped
half-live" failure shape this file warns about elsewhere, except here the
browser's own refusal-to-execute would be the symptom instead of a stale
bundle); and a repo-wide grep confirms zero inline event-handler attributes
remain anywhere in `js/` or any `.html` file.

**Verified two ways, not just by reading the diff.** A local Node server
served the actual repo with the actual `_headers` CSP value enforced,
Chromium (the browser already available in this environment) loaded all 12
real app pages plus a hand-written sanity page with a deliberately unhashed
inline script — the sanity page's script was correctly refused (proving the
test harness itself can detect a real violation, not just report "clean"
against a broken check), and all 12 real pages loaded with **zero** CSP
violations. Two unrelated `pageerror`s did appear on `clockin.html`/
`payroll.html` (`Cannot read properties of undefined (reading
'createClient')`) — traced to `net::ERR_CONNECTION_RESET` fetching
`cdn.jsdelivr.net` from the sandboxed test environment's browser process,
not a CSP refusal (a real CSP block reads as "Refused to load the script
... because it violates the following Content Security Policy directive,"
which never appeared) — a sandbox networking limitation, not a regression.

`npm test` — 191/191 (3 new CSP guards). `npm run build` — `dist/` rebuilt
and grepped for the new class names (`ar-lock-btn`, `ar-payment-btn`,
`trends-room-toggle`, etc.) to confirm the delegated-listener conversion
actually shipped in the bundle, not just the source.

### ⚠️ That PR broke the deploy — `_headers` has a 2,000-character-per-line limit (2026-08-28)

Cloudflare's `Workers Builds` check failed on the CSP-tightening PR within
minutes of opening it. Not a code bug — the CSP line in `_headers` had grown
to **2,151 characters** (22 sha256 hashes plus the existing directives), and
Cloudflare's own `_headers` docs are explicit: *"Each line in the `_headers`
file has a 2,000 character limit. The entire line, including spacing, header
name, and value, counts toward this limit."* This repo already has one prior
incident from exactly this file (the blank-`Pragma:` deploy failure
documented above) — worth remembering that `_headers` has hard, silent-ish
limits a normal code review won't catch.

Fixed two ways, one of them a real correctness fix rather than just a
line-length trim:

- **Extracted the 3 least-critical inline `<script>` blocks to external
  `.js` files** (`docs/manual.js`, `marketing/poster.js`,
  `marketing/website/site.js`) instead of hashing them. `script-src 'self'`
  already covers same-origin external scripts with no hash needed, so this
  drops 3 hashes (~150 characters) with zero behavior change, and as a
  side benefit these three pages' JS no longer needs a CSP-hash update
  every time someone edits their script content.
- ⚠️ **A real bug in the hash generation, not just a size optimization**:
  `<script type="text/x-dc" ...>` (the two `docs/design_handoff/*.dc.html`
  mockups' data blocks) and `<script type="application/ld+json">`
  (`index.html`'s SEO structured data) were being hashed and counted toward
  the line **even though browsers never execute either as JavaScript**.
  Verified empirically before relying on it: a `type="text/x-dc"` block
  with content matching nothing in the CSP produced **zero** CSP violation
  in a real browser — script-src simply doesn't gate a `<script>` tag the
  parser was never going to execute as script in the first place. Excluding
  non-JS `type` values dropped 3 more hashes and is the *correct* fix, not
  a shortcut — those hashes were dead weight that would have made every
  future JSON-LD or `.dc.html` edit falsely look like it needed a CSP
  update too.
- Final line: **1,827 characters** (was 2,151), with margin restored
  specifically so the next inline script or CDN host addition doesn't
  immediately reopen this exact failure.

**New guards**, both structural (would have caught this before it ever
reached Cloudflare):
- A dedicated test asserts the raw `_headers` CSP line stays under 1,950
  characters — checked against the actual line as written, including the
  `Content-Security-Policy:` label and leading whitespace, not just the
  directive value, since that's what Cloudflare actually counts.
- The script-hash drift guard now excludes non-executable `type=` script
  tags using the same allowlist a real browser does (absent/empty/
  `text/javascript`/`application/javascript`/`text/ecmascript`/
  `application/ecmascript`/`module`), so it stops falsely demanding hashes
  for content that was never going to run.

**Verified against the actual constraint, not just the test suite**:
recomputed the real full line (`Content-Security-Policy: ` prefix +
directives) at 1,827 characters, re-ran the same real-browser CSP check
from the section above against all four touched pages
(`payroll.html`/`docs/manual.html`/`marketing/poster.html`/
`marketing/website/index.html`) — zero script-src violations on any of
them, confirming the externalized scripts load correctly under `'self'`.

`npm test` — 192/192. `npm run build` — `dist/` rebuilt.

### Sandbox click-through testing reintroduced — `?staxtest=1` is back, differently (2026-08-28)

Asked directly to test the real Stax.js embedded-checkout flow. Turned out
the two-button `?staxtest=1` design this file describes earlier in the Stax
section (a second "Pay … with Stax (test)" button, visible only behind the
flag) had at some point been replaced with the current single-button design
(`pbStartStaxPayment()` always tries Stax first, silently falling back to
Authorize.net on `"Online payments are not configured for production yet."`)
— and nothing in this file had caught that the `?staxtest=1` mechanism was
gone entirely along with it. **A parent asking to test the flow got routed
straight to Authorize.net with no way to reach Stax at all**, because
`STAX_ENVIRONMENT` is still sandbox and the single button's fallback is
unconditional once that gate refuses.

⚠️ **Flipping `STAX_ENVIRONMENT` to `production` to unblock this would have
been exactly the mistake the last security review's hard blocker warned
against** — `STAX_API_KEY` is still a sandbox key, and telling the app it's
in production would record sandbox test money as if it were real tuition.
There is no real Stax merchant account yet, so that path was never on the
table.

Fixed by reintroducing a narrow, explicitly-opt-in bypass — a **two-signal
gate**, not a reopened hole:

- `pbStaxTestEnabled()` is back in `portal-billing.js`, same shape as the
  original: reads `?staxtest=1` off the URL once, then sticks in
  `sessionStorage` for the tab. The button itself is unchanged (same class,
  same "Pay $X online" label, no visible "(test)" marker) — this only
  changes what `sandboxTest` value rides along in the request body of
  `createStaxChargeSession()` and `chargeStaxPayment()`.
- `create-stax-charge` and `charge-stax-payment` both gate on
  `isProduction || (STAX_SANDBOX_TEST_ENABLED === "true" && body.sandboxTest === true)`.
  **Both signals are required.** The server secret alone does nothing to a
  real parent's normal click, since that request never sets `sandboxTest`.
  The URL flag alone does nothing unless the operator has also deliberately
  turned on `STAX_SANDBOX_TEST_ENABLED` — meant to be flipped on only for
  the duration of an active test session and back off immediately after,
  the same "belt and suspenders" reasoning the rest of this app's security
  fixes use (e.g. SX1's revoke-from-both-anon-and-PUBLIC).
- A charge that goes through this path is **real test money against Stax's
  real sandbox merchant** — not a faked success. It gets recorded in
  `billing_payments` exactly like any other Stax charge, which is the whole
  point: verifying the actual invoice/payment allocation, not just that a
  button doesn't error.
- `create-stax-charge`'s response `environment` field now honestly reflects
  `"sandbox"` when this path is taken, instead of being hardcoded to
  `"production"` regardless of which gate let the request through.

⚠️ **Setting `STAX_SANDBOX_TEST_ENABLED` is a manual dashboard step** — no
tool available in this session can set a Supabase Function secret. Turn it
on only while testing, and turn it back off when done; there's no code-side
reminder that it's still on.

`npm test` — 192/192 (2 of the older Stax tests were rewritten in place —
their assumption that `pbStaxTestEnabled` should never exist was itself the
thing this session found to be stale).

### A real sandbox click-through surfaced a real bug: a fake test phone number, rejected by Stax's own validator

With `?staxtest=1` working, an actual embedded-checkout charge was run
against a disposable test family in production (`stax-test-20260828@…`,
invoice `3992`) — the first time this flow had been driven through a real
browser rather than curl. The modal loaded and the card fields rendered
correctly, but `pbStaxInstance.tokenize()` failed every time with a bare
"Payment failed. Please check the card details and try again." — no detail,
because the thrown error in `pbStaxTokenizeAndCharge()`'s catch block had no
`.message`, meaning the failure never reached our own server at all.

Traced via the browser's own Network tab, not guesswork: BlockChyp's iframe
tokenized the test Visa fine, Stax.js then generated a reCAPTCHA token, and
the actual `POST … /token` request to Stax's API — the one that creates the
payment method — came back **422** with `{"phone":["The phone format is
invalid."]}`. `create-stax-charge` passes `family.parent_phone` straight
through as `extraDetails.phone` in the `tokenize()` call (no local
formatting or validation of its own — Stax's own validator is authoritative
here, correctly), and the disposable test family's `parent_phone` had been
set to `"555-0100"` — 7 digits, no area code. Not a code bug: fixed by
correcting the test fixture's phone to a properly formatted number
(`314-555-0100`). Stax's customer record (already created with the bad
phone on the first attempt) didn't need to be recreated — `tokenize()` sends
`phone` fresh on every call, so the very next attempt with the corrected
family row succeeded end to end (BlockChyp tokenize → Stax charge → this
app's own `charge-stax-payment` recording the `billing_payments` row).
**Worth remembering for the next sandbox test**: give the disposable test
family a real-shaped phone number, not an obviously-fake placeholder — Stax
validates it server-side and will reject a malformed one before ever
reaching this app's own code.

### Refunding a Stax payment had no admin path at all — built and deployed same session

Testing continued into "can the office refund a Stax charge" — and the
answer was no, not even partially. `renderPaymentHistory()`'s `canRefund`
check (`js/admin/admin-billing.js`) was `p.processor === 'authorizenet'`
only, so a Stax-processed row in the AR payment history got **no Refund
button at all** — not a broken button, an invisible one. The only edge
function that submits a reversal to a processor, `admin-refund-payment`,
explicitly rejects anything but `processor === "authorizenet"`
(`"Only an online card payment can be reversed this way."`). Confirmed by
reading both files, not assumed from the symptom: there was no dead code
to fix, the capability had simply never been built for the second
processor this app now takes real money through.

Fixed with a direct Stax counterpart, **`admin-refund-stax-payment`**
(deployed), mirroring `admin-refund-payment`'s exact security posture:

- Same gate — a valid Supabase Auth session **and** `admin_role() = 'full'`
  (read from the `admin_roles` setting, the same code path
  `admin-refund-payment` uses).
- Request body carries **only a `billing_payments` row id** — never an
  amount. The reversal amount is always that row's own `amount`.
- **Void vs. refund is decided from Stax's own `is_voidable` flag**, read
  fresh via `GET /transaction/{id}` before acting — never guessed locally
  from a locally-stored settlement guess, mirroring how
  `admin-refund-payment` reads Authorize.net's own `transactionStatus`
  rather than assuming. Voidable → `POST /transaction/{id}/void`; otherwise
  → `POST /transaction/{id}/refund` with `{total: <payment's own amount>}`.
  Both endpoint shapes confirmed against Stax's own API reference
  (`docs.staxpayments.com/reference/refund-transaction`,
  `.../void-transaction`) before writing the call — **not** the
  `/terminal/void-or-refund` endpoint, which is for card-present terminal
  transactions and requires a `register` id this app has no such thing as.
- ⚠️ **`billing_payments.processor_transaction_id` can carry this app's own
  `-inv<id>` or `-credit` suffix** (see `stax_finalize_charge` in
  `harden_stax_payments.sql` — a charge rolled up across several unpaid
  invoices is recorded as one row per invoice, all sharing the same real
  Stax transaction id with a different suffix). `baseTransactionId()` strips
  that suffix before ever calling Stax's API — sending the suffixed id would
  have 404'd on a real refund attempt for any rolled-up charge.
- Already-reversed payments, and payments Stax itself already shows as
  `is_refunded`/`is_voided`, are both rejected up front — belt and
  suspenders against a double-click submitting two reversals.
- **Does not touch `billing_payments` or invoice status** — same "request
  here, record on confirmation" split as the Authorize.net path and as the
  charge path itself. The actual reversal is recorded by the already-live
  `stax-webhook` (`stax_record_reversal`, applied and verified in production
  earlier this session) once Stax's own `create_transaction` event for the
  refund/void arrives and is independently re-verified — this function
  never writes billing state itself, only asks Stax to act.
- `js/admin/admin-billing.js`'s `canRefund` now checks
  `REFUNDABLE_PROCESSORS = new Set(['authorizenet', 'stax'])`; the button
  carries `data-processor` so the click handler
  (`refundOnlinePayment(paymentId, processor)`) and `adminRefundPayment()`
  (`js/supabase.js`) route to the right edge function — the Authorize.net
  path is completely unchanged, just no longer the only one.
- Not independently curl-tested end-to-end by this session (doing so would
  need a real admin login, which this session doesn't have) — verified by
  reading the deployed source and by the existing security-guard tests
  below; the live click-through is the director's own test, same as the
  charge flow above.

`npm test` — 200/200 (8 new guards: full-admin gate, processor/status
checks, the `is_voidable`-driven branch, the amount always coming from the
stored row, the suffix-stripping, no direct `billing_payments`/
`billing_invoices` write, and both the button and the JS routing).
`npm run build` — `dist/` rebuilt and grepped for
`admin-refund-stax-payment` (in `dist/supabase.min.js`) and
`Set(["authorizenet","stax"])` (in `dist/admin.min.js`) to confirm the
feature actually shipped in the bundles the live site loads, not just the
source — the standing check this file has asked for since the Bookkeeper
and Enrollment & Capacity tabs each shipped half-live.

### ⚠️ …and the button above was wired into a genuinely dead section — found within the hour, by the person testing it

Asked directly, minutes after the PR above merged: "where is refunds?" — on
the live **Finance → Bookkeeper → Accounts Receivable** screen, which shows
only an aging summary (banner + 0–14/15–29/30+ day bands), no per-payment
list, no button of any kind. The Refund button this session had just built
was real, tested, and shipped in the bundle — and **unreachable**, because
it was added to `admin-billing.js`'s `renderPaymentHistory()`, which only
ever renders inside `billingArSection`'s `#arTableWrap` — and
`billingArSection` is one of the ten tools this file's own Finance-tab
overhaul section already documents as retired from `AP_TOOLS` in the
2026-08-27 Bookkeeper redesign ("Accounts Receivable, Reconcile Payments,
Revenue Dashboard…"), unreferenced and therefore unreachable per the
shell's own rule (`apShowSection()` never shows a section no `AP_TOOLS`
entry points at). Confirmed by grepping `admin-portal.js` for
`billingArSection` — zero matches.

⚠️ **This means the pre-existing Authorize.net refund button — not just the
Stax one this session added — has been unreachable since that same redesign
merged**, a full day before this session started. Nobody had needed to
refund an online payment in the meantime, so nothing surfaced it. This
wasn't caused by this session's change; this session's change just happened
to add a second, equally-invisible button right next to the first one,
which is what made it worth checking where "the AR table" that
`admin-billing.js`'s comments still describe actually renders today.

**The fix wasn't re-registering `billingArSection`.** The whole point of
retiring it was fewer screens computing the same numbers differently, and
reopening it as a nav entry would have undone that. Instead, the Refund
control was added to the place a family's payments are actually visible
today: the **Ledger drawer** (`_fhLoadDrawerBody()` in
`admin-finance-hub.js`, opened from Finance → Ledger by clicking any family
row) — which already had its own "Payments" list and a "+ Record payment"
button, but no way to reverse one. New `_fhCanRefund()` (same gate as the
old `renderPaymentHistory()`: processor is `authorizenet` or `stax`,
positive amount, not itself a reversal, not already reversed) and
`_fhRefundPayment()` (confirm → `adminRefundPayment(paymentId, processor)`
→ `_fhLoad()`, the same reload `_fhSubmitPayment()` already does after
recording a payment, so Bookkeeper's cache invalidates and the drawer
re-renders with current data). `admin-billing.js`'s original wiring was
left in place rather than deleted — same "unreferenced, not deleted"
convention this file uses for every other retired tool, in case
`billingArSection` is ever revived — but it is dead weight, not a second
live implementation to keep in sync.

**New drift guard**, specifically to stop this exact class of mistake from
recurring: a test asserts `billingArSection` stays absent from
`admin-portal.js` (documenting that it actually is dead, not assuming it)
*and* that `admin-finance-hub.js` carries the real, reachable refund wiring
— so a future refund-related change made only to the old file would fail
this test rather than ship silently unreachable again.

**The lesson to take from this, generalized:** `npm run build` + grepping
the bundle for a new symbol (this file's standing check since the
Bookkeeper/Enrollment & Capacity "shipped half-live" incidents) proves a
change is *in* the bundle. It does not prove the bundle's own code path
that contains it is one `apShowSection()` will ever call. For any change to
a section's markup or its rendering function, check `AP_TOOLS` for that
section id too — a symbol present in the bundle and a feature reachable in
the shell are two different claims, and this file's existing checklist
only ever verified the first one.

`npm test` — 203/203 (3 more guards: the dead-code confirmation, the live
drawer wiring, and the double-refund guard). `npm run build` — `dist/`
rebuilt and grepped for `_fhRefundPayment`/`_fhCanRefund` to confirm the
*actually reachable* version shipped, not just the first one.

### ⚠️ It shipped half-live a THIRD time in the same evening — and this time the root cause was in the auto-merge workflow itself, not in this feature

The director tested the fix above from a fresh admin login (version badge
correctly reading the new build) and the Refund link still wasn't there —
twice. Both times, `git show origin/main:dist/admin.min.js | grep -c
_fhRefundPayment` came back `0` while the *source* on `main` had it the
whole time. Not a browser cache issue either time (ruled out directly: the
version banner embedded inside `dist/admin.min.js` itself, not just the
HTML, matched the deployed `package.json` version — so the exact bundle
running in the browser really was the one just deployed, and it genuinely
lacked the fix). Two more `claude/**` branches had each merged into `main`
within the same half hour, each hitting the identical dist conflict this
file already documents twice above (Bookkeeper, Enrollment & Capacity) —
except by the third occurrence in one evening it was clear the fix each
time ("rebuild and re-push") was treating a symptom, not the disease.

**Root cause, found by finally reading `.github/workflows/auto-merge-claude.yml`
line by line instead of re-patching around it a fourth time:** the
conflict-resolution step's own comment said "take the branch's dist
bundles (they were built on top of main's JS)" and unconditionally ran
`git checkout --theirs` for every conflicting `dist/*.min.js` — with
**no check on which side was actually newer**. That assumption holds for
exactly one merge in isolation. It silently breaks the moment a *second*
`claude/**` branch is queued behind a first: branch B was forked from (and
last built its own `dist/` against) a `main` that predates branch A's
merge. By the time B's own turn to merge arrives, "theirs" is B's
own bundle — stale relative to the `main` this merge is about to produce —
and the workflow took it anyway, every time, because nothing about the
rule was version-aware. The `sort -V | tail -1` logic just above it in the
same step only ever decided the **version number string** written into
`package.json`/`build-version.js`; it never gated which side's `dist/*.min.js`
bytes got used. Two completely different questions were being resolved by
one comparison that only answered the first.

**Fixed by not picking a side at all.** On any conflict that reaches this
step, `dist/` is now unconditionally **rebuilt from the just-merged source**
(`npm run build`, then a follow-up commit if it produced a diff) instead of
`git checkout --theirs` on the bundle files. A bundle generated from the
tree this exact merge just produced cannot be stale relative to that tree —
there's no side to pick wrong. This also fixes a subtler case the old rule
never touched at all: two branches whose `dist/*.min.js` happened to merge
with **no textual conflict** (neither touched the same bytes) still ended
up carrying the *old* `__BUILD_VERSION__` banner from whichever side's
un-conflicting copy git kept, mismatched against the version number the
`package.json` conflict resolution had just forced to something higher.
Rebuilding fixes that silently-wrong case too, which a "pick the right
side" rule could never have covered because there was no wrong side to
avoid — both were stale relative to the version just written.

⚠️ **This needed Node available earlier in the job.** `actions/setup-node`
+ `npm ci` were previously only run right before the deploy step, after the
merge had already been pushed. Both moved up to before the merge step, so
`npm run build` has a working toolchain available mid-conflict-resolution.

**Not chased further:** the `verify` job (which runs per-branch, before
this) still cannot catch this class of bug on its own — it rebuilds and
diffs `dist/` against that one branch's own `js/`, which was correct
*for that branch in isolation* at push time. The staleness only exists
relative to whatever `main` looks like at the moment its merge is actually
processed, which `verify` has no way to know in advance. The fix has to
live in `merge-to-main`, where the real merged tree exists — which is
exactly where it now does.

---

## Ledger's "Total to bill" was a net figure with nothing showing its parts — broken into a 4-box strip (2026-08-28)

Asked directly: the Ledger tab's headline stat read as one opaque number, with
no visibility into how much of it was tuition versus discounts versus fees.
`_fhRenderLedger()` (`js/admin/admin-finance-hub.js`) now shows a chained
sequence — **Tuition (before discounts) → Discounts → Fees → Amount to
collect** — instead of the single `fh-stat-month` box. Nothing new is
computed: `computeBillMonthExceptions()` (`js/admin/admin-bill-month.js`)
already produces `base` (net of both the individual and sibling discount),
`discount` (the sum of both), and the fee fields per family; `_fhLoad()` was
only keeping `total` and `causes` off that object and discarding the rest.
It now carries `base`/`discount`/`changeFees`/`regFee`/`familyNewFee`/
`creditTotal` through into `_fhRows` too.

- **`grossTuition = Σ(base + discount)`** — the pre-discount sticker price,
  reconstructed by adding the discount back onto the already-net `base`.
- **`discountsTotal = Σ(discount)`**, shown as `_fhMoney(-discountsTotal)` so
  the existing negative-number formatting in `_fhMoney()` supplies the minus
  sign rather than a hand-built one.
- **`feesTotal = Σ(changeFees + regFee + familyNewFee − creditTotal)`** — the
  same fee fields the per-family exception card in `admin-bill-month.js`
  already itemizes, net of any account credit applied that month.
- `grossTuition − discountsTotal + feesTotal === monthTotal` (the existing
  "Amount to collect" figure), by construction — nothing about the final
  number's *own* computation changed, only what got exposed alongside it.

⚠️ **A real bug surfaced while wiring this up, not introduced by it.**
`computeBillMonthExceptions()`'s `total` was `base + regFee + familyNewFee −
creditTotal` — no `changeFees`. The sibling `prevFamilyTotal` calculation nine
lines above it *does* include `c.changeFees`, so the current month's total and
the prior month's total (used for the same-screen "vs. last time" comparison)
were computed on different bases. Any family with a schedule-change fee this
month was undercounted in the Ledger's month total, the "Bill the Month"
screen's own total, and the per-family "Approve $X" button — though never in
what actually got billed, since `reconcileBillingInvoice()` recomputes the
real invoice amount server-side and never reads this client total. Fixed by
adding `+ changeFees` to the formula; flagged with an inline comment at the
fix site so it isn't lost the way this file warns about elsewhere.

`npm test` — 200/200 (no new guards needed; existing Stax/CSP/billing-integrity
suites all held). `npm run build` — `dist/` rebuilt and grepped for `Amount to
collect` / `before discounts` in `dist/admin.min.js` to confirm the new strip
actually shipped in the bundle, not just the source.

### ⚠️ The Fees box was toggling between ~$300 and ~$15,300 — a real registration-fee-year race, not a rendering bug (2026-08-28)

Reported directly: "sometimes the fees box will show 15,300 dollars and
sometimes 0, i think it should be 0 i havent charged fees this month like
that." Checked live against production (`dahdstopsumxnqvdclmy`) rather than
guessed at — the center's real registration-fee settings are `$150`/child
capped at `$200`/family, renewal date **09-01**. Today (08-28) is four days
before that renewal, so the correct fiscal cycle year is **2025**, and under
that year only **2 children** in August's roster still owe the fee (~$300).
`reg_fee_paid_year` is `2025` for 135 students, `NULL` for 17 — confirms most
of the roster already paid for the cycle that's still open.

**Root cause: `currentFeeCycleYear(window._regFeeRenewalDate)` had no fallback
fetch.** `computeBillMonthExceptions()` (`admin-bill-month.js`) and
`generateFamilyBillingReport()` (`admin-reports.js`) both already guard the
three dollar-amount fee settings with `window._X ?? (await
fetchSetting(...))` — but the renewal-date line was reading
`window._regFeeRenewalDate` directly, with no such guard. `setupRegFee()`
(`admin-settings.js`, called from `admin-init.js`) is what actually populates
that global, and it's async — if either screen was opened before it
resolved, `currentFeeCycleYear()` silently fell back to its own internal
default, `'01-01'`. Since `'01-01'` has already passed this calendar year,
that default computes `currentYear = 2026` (this year) instead of the true
`2025` (last year's cycle, still open until 09-01) — and because none of the
135 already-paid students carry `reg_fee_paid_year = 2026` yet, **every one
of them looks unpaid** under the wrong year. Verified the exact swing live:
117 of August's booked children would be flagged "owed" under the buggy 2026
read versus 2 under the correct 2025 read — $15,550 vs $300 in raw
registration-fee terms, which lines up with the $15,300 the Fees box (which
also nets in change fees / new-family fee / credits) actually showed.

⚠️ **`generateFamilyBillingReport()`'s copy of this bug was the more serious
one.** Unlike the Ledger/Bill-the-Month preview, that report *stamps*
`reg_fee_paid_year` onto every student it charges the fee to the moment it's
generated — so hitting this race there wouldn't just misdisplay a number, it
would have charged and permanently marked roughly 117 children as paid for
the wrong cycle. Checked live before writing this up: zero students currently
carry `reg_fee_paid_year = 2026`, so this hadn't fired yet — the landmine was
live, not sprung.

Fixed in both places with the same `window._regFeeRenewalDate ?? (await
fetchSetting('registration_fee_renewal_date'))` guard the other three fee
settings already use, matching each file's own existing style
(`??`-chained in `admin-bill-month.js`, try/catch in `admin-reports.js`,
where the three settings just above it already use that idiom).

Also fixed in passing: the Finance family drawer's own header (`.inc-drawer`
/ `.inc-scrim`, shared with the incident drawer) was `z-index: 60/61` while
`.admin-header` is `position: sticky; z-index: 100` — the sticky green top
bar rendered on top of the drawer's own head, cutting off the family name at
the top of the panel every time it opened. Raised to `150`/`151`, clearing
every other `z-index` in the app under `500` (the mobile tab bar and
above) while staying below the toast/modal tier (`1000`+). This is a shared
component, so the fix isn't Finance-specific — it clears the same bug for
the incident drawer too, wherever else `.inc-drawer` is used.

`npm test` — 200/200. `npm run build` — `dist/` rebuilt and grepped for
`registration_fee_renewal_date` in `dist/admin.min.js` to confirm both fixes
shipped in the bundle.

### ⚠️ The Ledger's "owed" banner counted every drafted-but-unsent invoice as a real receivable (2026-08-28)

Follow-up question from the director, prompted by the Fees-box investigation
above: why does the "owed" banner (83 families, $54,014.56) show fewer
families than "Ready to send" (97), and shouldn't accounts from before
August already be cleared since real invoicing/billing here is brand new?

Checked live before assuming either half of that was right. **There is no
pre-August backlog to clear** — `billing_cycles`/`billing_invoices` for
2026-06 and 2026-07 have **zero rows**. Every dollar of the $54,014.56 is
from **August itself**: 95 `billing_invoices` rows exist for August, and
**94 of them had never been sent** (`sent_at IS NULL`) — only one real send
had ever gone out (a $5.00 Stax sandbox test charge from earlier this
session, `invoice 3992`, $4 already paid on it). Those 94 unsent drafts'
combined `final_amount` was **$54,013.56** — matching the owed banner almost
to the dollar.

**Root cause:** `reconcileBillingInvoice()` drafts a `billing_invoices` row
for every clean family the moment Bill the Month computes them — well
before Release/Send is ever clicked (see "Billing writes are now
recompute-only" above). `_buildArRows()` (`admin-billing.js`) read
`billed = inv?.final_amount` with no check on `inv.sent_at`, so a drafted
invoice nobody has emailed yet counted as a real receivable — inflating
"owed," inviting "Nudge all 83" to nudge families for bills they had never
actually been shown, and (before this fix) would have misread as
`status: 'overdue'` rather than simply not-yet-billed.

This is the exact same principle FS29 already established for **aging**
("an invoice nobody has sent is not overdue") — applied one step earlier:
**an invoice nobody has sent isn't owed yet either.**

⚠️ **`billed` itself was deliberately left alone** — only `outstanding`/
`status` are now gated on `sent_at` (`billedIfSent`, a separate local). The
raw `billed` figure is still what the Finance drawer's "Base tuition" line
and the Ledger's month-history fallback read (`r.ar?.billed || r.total`) —
both want "what does the draft say," sent or not, and zeroing `billed`
outright would have shown $0.00 tuition in the drawer for anyone whose
invoice hadn't been sent. Two call sites in `admin-finance-hub.js`'s "Paid
in full" chip count were checking `r.ar?.billed > 0` as a proxy for "this
family has been sent something" — that stopped being true once `billed`
could be nonzero while unsent, so both were switched to check `r.ar?.sentAt`
directly, the thing they actually meant.

Guarded with a real behavioral test (not just a source grep, given the
dollar stakes): `_buildArRows` copied into
`js/tests/business-logic.test.js` with its own drift guard, plus four
cases — an unsent draft is billed-but-not-owed, the same amount becomes
owed once sent, a fully-paid sent invoice reads `paid`, and a payment
against an unsent draft can't push `outstanding` negative.

`npm test` — 205/205 (4 new behavioral cases + 1 drift guard). `npm run
build` — `dist/` rebuilt; `_buildArRows` confirmed present in
`dist/admin.min.js` (the specific local-variable rename that carries the
fix doesn't survive minification as a greppable symbol — this is one of the
rare fixes where the standing "grep the bundle for a symbol only your
change introduces" check doesn't apply, since nothing new was added at
module scope).

---

## Parent payment flow redesign — receipt email shipped, portal UI in progress (2026-08-28)

Built from a director-supplied design mockup of the parent app's payment
flow (Billing home → All invoices → Invoice detail → payment modal →
Payment received) plus the branded HTML receipt email. **Phase 1 — the
receipt email and its supporting data — is built, deployed, and live.** The
portal UI itself (Home/All Invoices/Invoice Detail screens, Stax modal
polish, an in-app Payment Received screen) is a separate, larger phase not
yet started; see the punch list at the end of this section.

### `my_schedule()` now returns `last_payment_date` per invoice

`20260828211214_parent_schedule_invoice_last_payment_date.sql`, **applied
and verified in production.** Purely additive — same signature, same
`STABLE SECURITY DEFINER`, same `search_path`, one more computed field
(`max(billing_payments.payment_date)` for that invoice) in the jsonb
payload. Needed so the eventual Invoice Detail screen can show "Payment
date" without a second round trip or exposing individual `billing_payments`
rows (payment_method, notes) the parent app has no reason to see.

### The receipt email — redesigned and deployed for both processors

`sendReceiptEmail()` in `charge-stax-payment/index.ts` and
`authorizenet-webhook/index.ts` (deployed versions 15 and 18) both rebuilt
from the mockup: navy header with the real `myMDO_primary_logo_light.png`
logo (the same asset `send-schedule-confirmation` already uses — no
placeholder "Logo" box, since there's nothing to embed that isn't already a
real, hosted asset), a green checkmark, "Payment received" / "Thank you,
{family}." / the amount, a bordered Invoice/Paid on/Payment method/
Confirmation# box, a Current month charges / Prior balance / Total paid
breakdown, a "View billing account" button linking to `portal.html`, and a
contact footer (the real office phone/email, already used elsewhere in this
app — see `incident-print.html`).

- **No-reply is deliberate, not an oversight.** The old template said "just
  reply to this email" — this app has a real staffed billing inbox
  (`RESEND_REPLY_TO`), so that wasn't wrong, but the mockup's own explicit
  contact line (phone + billing email) is a clearer, more discoverable
  replacement for a receipt specifically, which is a confirmation, not a
  support channel. Genuinely dropped the `reply_to` header on this template.
- **The current-month/prior-balance split is read from the database, not
  computed.** Both processors can roll one payment across several unpaid
  invoices (`stax_finalize_charge()` / `allocateAcrossPaymentRows()`, both
  tagging each resulting `billing_payments` row's
  `processor_transaction_id` with `-inv<id>`). The receipt re-reads those
  exact rows, splits by whether each row's invoice month matches the
  anchor invoice's own month, and shows the breakdown only when both sides
  are nonzero — so it can never disagree with what the Ledger already shows,
  and a single-invoice payment (the common case) just shows one "Total
  paid" line with no breakdown clutter.
- **Card brand/last-four appears only for Stax.** `charge-stax-payment`
  already extracts this from the charge response (previously only when
  `saveCard` was checked; now read unconditionally so the receipt can show
  it either way) or, on a saved-card charge, from the family's own stored
  `stax_default_card_brand`/`_last_four`. `authorizenet-webhook` has no
  verified field name for this in Authorize.net's transaction-details
  response — nothing in that file has ever extracted card metadata from it
  — and this repo does not guess at an unverified field on a live payment
  API. `buildReceiptHtml()` (identical copy in both files, no shared import
  path between edge functions in this repo) simply omits the row when
  `paymentMethodLine` is `null`.
- **`monthLabel()` was dropped from both files** — the old "Payment
  Receipt" / month-title header and the "Days of care" line it fed are gone
  in the redesign, and it had no other caller left.
- **`verify_jwt` was preserved explicitly on redeploy.**
  `authorizenet-webhook` must stay `verify_jwt: false` — it's called
  server-to-server by Authorize.net with no user JWT, authenticated by its
  own HMAC signature check instead. The `deploy_edge_function` tool defaults
  `verify_jwt` to `true` when omitted; passing `false` explicitly here was
  the difference between a working webhook and every real online payment's
  confirmation silently 401'ing.

### Still to build — the portal UI itself

The mockup's actual screens are unbuilt: `portal-billing.js`'s Billing tab
is still the single flat list of invoice cards it already was (see that
file's own header comment), not the mockup's Home → All Invoices → Invoice
Detail flow with a "Show breakdown" toggle, a prior-balance warning banner,
and a per-child day-of-care calendar. Also unbuilt: an in-app "Payment
received" confirmation screen (today a payment just re-renders the same
list with a banner) and matching polish on the Stax payment modal (an
always-visible "Balance due" box, the invoice number in the subtitle,
processor-neutral footer copy instead of naming Stax by name).

⚠️ **Deliberately scoped out of the Invoice Detail screen when it is
built: a per-day dollar amount.** `my_schedule()` already returns real
per-day `care_date`/`day_type` data (used for the calendar), but no per-day
price — the itemized `lineItems` this app already computes
(`compute_family_month_charges_itemized()`) are aggregated per child
(full/half day counts + one amount), not per individual date, and they're
only returned by `create-stax-charge`, which reserves a real payment
attempt — not something to call just to render a read-only view. Showing a
day-cell dollar figure would mean inventing a second, client-side billing
calculation that could drift from the real one; the day cells should show
`day_type` only, with the child's real dollar figure coming from the
already-correct child subtotal, not a per-day multiply.

`npm test` — 205/205 (unaffected — this phase touched only edge functions
and one migration, no `js/`). No `dist/` symbol check applies to this phase
for the same reason; the next phase (the actual UI) will need the standard
`npm run build` + bundle-grep discipline this file asks for everywhere else.

---

## Parent app redesign — phone and desktop (2026-08-28)

Built from the director's redesign screens for **Today, Recap, Schedule,
Billing, Messages and Account**, phone and wide. Nothing about what the portal
*reads* changed — no new RPC, no migration, no new query. This is the same six
tabs, restyled, plus one genuinely new card (This week) built entirely from
data three tabs already had in hand.

### ⚠️ One navigation element, two layouts

`#ptTabs` renders the same six buttons either way — **`portal-nav.js` is
untouched**. Below 900px the new `<aside class="app-nav">` is the fixed bottom
tab bar this app already had; at 900px and up CSS turns it into the navy rail
with the myMDO mark above it and the active tab as a solid `--sun` pill. There
is deliberately no second nav to keep in step with the first.

- **The rail is `order: -1`, not a DOM move.** The nav stays last in the
  document — it is the bottom bar on a phone, and a nav rendered before the
  content it sits under would be wrong for a screen reader as well as for CSS.
- ⚠️ **Every layout override is scoped to `.portal-app`.** `.app-shell`,
  `.app-route` and `.tabbar` live in `css/styles.css` and are shared with the
  **staff** app; widening those selectors here would have restyled an app this
  redesign was never scoped to touch.
- `.portal-app`'s `max-width: 560px` and `margin: 0 auto` (the phone shell is a
  centered column) both have to be lifted inside the media query, or the rail
  layout renders as a 560px strip floating in the middle of the window. Caught
  in a real browser, not from the diff.
- 900px is the same breakpoint the admin shell already uses for its drawer,
  deliberately, rather than adding a seventh number to U4's list.

### ⚠️ `.pt-tab` was two different things, and the CSS hit both

Each full-page `<section>` in the shell is `class="pt-tab"` — and so was every
button in the child switcher. So a rule written for a pill (`border-radius:
999px`, `min-height: 44px`, `flex: 1`) was landing on six whole screens, and
`.pt-tab { padding: 0 16px }` (the shell's page padding) was landing on the
buttons. Both were live on `main` and neither was visible as a bug, because the
section rules happened to be harmless and the page padding on a pill just made
it wider.

The switcher buttons are **`.pt-childbtn`** now, in all three files that render
one (`portal-today.js`, `portal-recap.js`, `portal-schedule.js`), and the old
`.pt-tab` pill rules are deleted rather than left to apply to sections.

### One `my_schedule()` fetch, shared by three tabs

`psSchedule()` (portal-schedule.js) memoizes the call. Schedule reads booked
days from it, Billing reads invoices from it, and Today now reads the child's
**room label** from it — three tabs asking the database the same question three
times was three round trips for one answer. A rejection is **not** cached, so a
failed load is retryable by reopening the tab rather than sticky for the
session.

### "This week" derives nothing of its own

Days booked and balance due come out of that same payload; unread comes from
`pmUnreadCount()`, which counts **without** marking anything read (see the note
on that function — calling `pmLoad()` for the number would clear the badge for
a parent who never opened the tab).

⚠️ **Balance due counts ISSUED invoices only (`sent_at` set)**, exactly as the
Billing tab does — the same "a draft is not a bill" rule this file already
records for `psStatusPill` and `_buildArRows`. The card and Billing therefore
cannot disagree.

### Billing shows day counts per child, never dollars per child

The redesign's month card lists each child with a figure beside them. The
invoice carries **one** total, computed server-side; splitting it per child in
the browser would be a second billing calculation that can drift from the bill
itself. `pbChildLines()` shows each child's room and **days booked** — facts the
payload already holds — and the invoice's own Total underneath. Same call, same
reasoning, as the per-day amount already scoped out of the invoice detail
screen.

### ⚠️ There is no emergency-contact field in this database

The Account design shows one. `families` / `parent_accounts` hold parent 1 and
parent 2 and nothing else; the real emergency contact is on the paper
enrollment form. `paEmergencyValue()` shows the **other parent on the record**
when there is one — who the center actually calls second — and otherwise says
plainly where the answer is kept.

It deliberately does **not** reuse a pickup contact: "may collect your child"
and "call this person in an emergency" are different permissions, and quietly
treating one as the other is the kind of thing that only surfaces on the day it
matters.

### Deliberate deviations from the screens

- **Messages has no child switcher.** The design shows one; a thread is per
  **family** (one row per family in `message_threads`). Pills that filter
  nothing, or that show the same conversation twice, would be worse than no
  pills. Splitting threads per child is its own piece of work.
- **Account keeps Parents & guardians, Approved for pickup and Notifications.**
  The Account screens show only Children, Contact info and Documents. Those
  three cards are the only place a family can manage the pickup list, their PIN
  and their notification preferences, so they were kept below Contact info
  rather than deleted on the strength of a screen that may simply be
  abbreviated. **Worth confirming with the director** — if they are genuinely
  meant to go, they need somewhere else to live first.
- **Documents was not rebuilt.** `portal-documents.js` still renders its four
  sections (incidents, forms, immunization, statements) rather than the
  design's flat list of rows with a View button. It lays out in the new card
  grid on a wide screen and is otherwise untouched.
- **Recap's day strip is a window AROUND the selected day** (3 back, 3 forward),
  oldest first, replacing "the last 8 days counting backwards" — so stepping
  with ‹ / › reads as moving along a strip that stays put. A future day keeps
  its place but is `disabled`: the strip does not change shape, and there is
  still no peeking at a day that has not happened.
- **Schedule renders every child's card every time.** Which ones are visible is
  CSS: the phone shows one behind the switcher, the wide layout lays them side
  by side and hides the switcher entirely. Both screens are satisfied by one
  render rather than one of them being a special case in the JS.

### ~~⚠️ `Parent Portal Desktop.dc.html` was NOT read~~ — RESOLVED 2026-08-29

The director pointed at the Claude Design project
(`05e91ea7-93c5-43f5-9875-8f9b7d69ad93`) mid-session. `DesignSync` needs a
`/design-login` this remote session cannot run, and the file is not in
`docs/design_handoff/`, so **this was built from the screenshots**. This file's
own Staff-tab entry says exactly why that is not good enough ("Read the
`.dc.html` template directly rather than re-guessing from a screenshot a second
time") — the source carries the literal hex values and the data-shaping the
screens only imply. Seed that file into the repo and re-check this work against
it before calling the redesign matched.

**Both files are now in `docs/design_handoff/`** (`Parent Portal Desktop.dc.html`
and `Parent Portal Mobile.dc.html`, arriving via a Claude Design handoff bundle)
and the redesign has been re-checked against them — see the section below for
what actually drifted. **The screenshot-built pass got the structure right and
the literals wrong**, which is exactly the failure mode the Staff-tab note
predicted: nothing was in the wrong place, and eight separate values were the
wrong color, size or shape.

### Verification

`npm test` — 168/168. `npm run build` — `dist/` rebuilt and grepped for
`pt-childbtn`, `ptWeekCard`, `pbChildLines`, `paEmergencyValue`,
`portalGreetingWord` and `psSchedule`, per this file's standing "it shipped
half-live" check.

Rendered in a real browser at 390px and 1280px against a harness carrying the
exact markup each renderer emits — which is what caught the 560px shell cap,
the sidebar landing on the right, and the print button eating the header row.
None of the three was visible in the diff.

---

## Parent app redesign, reconciled against the real design source (2026-08-29)

The two `.dc.html` files the section above says were missing are now committed
to `docs/design_handoff/`, and every screen was re-checked against their
literal values rather than against screenshots. **No screen was in the wrong
shape** — the structure the previous pass built from screenshots was right.
What was wrong was values, and a screenshot cannot carry a value.

### What actually drifted, and why each one mattered

| Was | Is | Why it read wrong |
|---|---|---|
| Child switcher track `--warm-gray` (#F5F0E4) | `#f2f5f7` | Both sources carry the cool literal. The warm token is within a few percent of the cream page behind it, so the segmented control had no visible track — it read as two loose buttons. |
| Switcher's raised pill had a `--border` ring | shadow only | The design raises the active child with a shadow alone; the ring flattened it back into the track. |
| `.pm-theirs` a borderless row with a divider under it | a real `#f2f5f7` bubble, squared bottom-left, 78–82% max-width | **The biggest one.** Messages had one visible side, so a teacher's note and the parent's reply read as a list of notices rather than a conversation. |
| Composer `border-radius: 999px` | `10px` | The composer is two rows tall; a pill radius on a two-row box bows its sides. |
| Photo strip `auto-fill, minmax(96px, 1fr)` | `repeat(4, 1fr)` | Both sources say four explicitly. Auto-fill gave three on a phone and up to six on a wide monitor, so the strip changed shape with the window. |
| Schedule days a stretch-to-fit grid (`minmax(74px,1fr)`) | wrapping flex, `min-width: 48/52px` | The grid stretched a four-day month across the whole card, making a light month look full. |
| Half-day chip border `--sun` (#F5B731) | `#FDE598` | The saturated CTA yellow ringed the chip hard enough to outrank the closed-day strikethrough next to it. |
| Recap day strip border 1px `--border` | 1.5px `#eef1f4` | That strip sits on the cream page, not inside a card; the warm tan border vanished into it. |
| Today's side column `1fr / 1.55fr` | fixed `320px` | Past ~1400px the side panel grew wider than the day card it annotates. |
| `.ps-cards`/`#ptAccountBody`/`.pd-body` `auto-fit, minmax(330px,1fr)` | `repeat(2, …)` + the design's own max-widths (920/960px) | On a wide monitor auto-fit gave three or four columns, turning a family's two children into a row of narrow strips. |
| Rail: 228px, 118px mark, 15px rows, `#E7EEF4` labels | 236px, 132px, 14px, `rgba(255,255,255,.72)` | A solid near-white on all six labels competed with the gold active pill, which is the only thing in the rail meant to be bright. |

### Nav icons are the illustrated PNG set now, in both layouts

`images/icons/{today,recap,schedule,billing,messages,account}.png` (from the
handoff bundle) replace the emoji in `PT_TABS`. ⚠️ **The desktop source uses
emoji for the rail** — putting the PNGs there too is a deliberate deviation the
director asked for, not a match. Rail glyphs render at 22px, the bottom bar at
26px, per the mobile source.

⚠️ **`.tabbar-icon` is rendered by three different files.** `staff-nav.js` and
`admin-portal.js` both emit the same span with an emoji inside it, so **every
image rule is scoped to `.portal-app`**. Widening one puts a broken image in
two apps this redesign never touched.

### Messages still has no per-child switcher — and the sources disagree here

The **mobile** source gives Messages an Emma/Owen switcher with a separate
thread per child. The **desktop** source does not, and the desktop source
agrees with the schema: a thread is per **family** (one row per family in
`message_threads`). Pills that filter nothing, or that show the same
conversation twice, are worse than no pills. **Splitting threads per child is
real schema work, not a CSS reconcile** — decided with the director rather than
inferred, and left for its own session.

### Kept against the sources, deliberately

- **"This week" stays on the phone.** The mobile source's Today screen has no
  such card. It is real data a parent glances at, and the same
  "match the visual language while keeping the data" call this file already
  made for Enrollment & Capacity's FTE table.
- ⚠️ **Sign out stays at the foot of Account, not in the rail**, even though
  the desktop source draws it in the rail. There is exactly one such button
  (`#portalSignOutBtn`, inside the Account section), and the mobile source puts
  it exactly where it already is. **The first attempt styled it for the rail
  from inside the ≥900px block and painted white-on-cream text at the bottom of
  the Account tab** — invisible, and invisible *only* above 900px. Caught in
  the browser, not in the diff. A rail copy would mean two buttons and two
  handlers to keep in step, which is what the one-nav-element rule exists to
  avoid.

### Verification

`npm test` — 211/211, including the CSP guards: the two new `.dc.html` files
carry `<script type="text/x-dc">` blocks, which the hash guard correctly
excludes as non-executable, so no CSP hash or `_headers` change was needed.

`npm run build` — `dist/` rebuilt and `dist/portal.min.js` grepped for
`tabbar-img` and `images/icons/today.png`. **CSS is not bundled**, so the
bundle check covers only the nav change; the CSS is verified below instead.

Rendered in Chromium at 390px and 1280px across all five screens against a
harness carrying each renderer's exact markup — zero console errors, zero
horizontal overflow. ⚠️ **`.portal-body.portal-app-open` sets `overflow:
hidden` and `.app-route` is the only scroller**, so a `fullPage: true`
screenshot silently clips to the viewport and everything below the fold looks
missing. Use a tall viewport, not `fullPage`, when shooting this app.

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

---

## Home page classroom cards are server-rendered in `worker.js` (2026-08-16)

`#roomInfoGrid` used to ship as an empty `<div>` that `js/app.js` filled from
Supabase after load. Google does run JavaScript, but on a deferred second pass it
is not obliged to finish — so the ages, rates, capacities and ratios, which are
exactly what a parent searches for, were the *least* reliably indexed content on
the page. `worker.js` now fills them with `HTMLRewriter` before the HTML leaves
the edge, for `/` and `/index.html` only.

- **It reads live settings, not a build-time snapshot, because the two disagree.**
  The `ROOMS` defaults in `js/supabase.js` say Goose is 30–36 months and Owl is
  36+; the saved `room_rates` setting says 36–60 and 24–36. Baking the defaults
  into the HTML would have published wrong ages and capacities to Google with
  nothing to notice it. Settings are fetched with the anon key and cached in
  `caches.default` for 5 minutes per edge location.
- **It fails open.** Any error, timeout (2s) or missing key returns the page
  untouched — a Supabase outage must not take the marketing page down.
- ⚠️ **It only runs because `wrangler.jsonc` now sets
  `assets.run_worker_first: ["/", "/index.html"]`.** Workers Assets serves any
  request matching a file on disk **without invoking `worker.js` at all**, so
  the first deploy of this feature shipped and did nothing — the grid stayed
  empty and the fail-open path hid it. **Proof technique:** `Service-Worker-Allowed`
  is set only by `worker.js`, and it was absent from the live `/sw.js` response.
  Use that header, not the CSP, to test whether the Worker ran — `_headers`
  sets a matching CSP, so the CSP looking right proves nothing.
  - Corollary: **`_headers` is the effective policy for every other path**, and
    `worker.js`'s Cache-Control/CSP block is dead code there. A header change
    made only in `worker.js` will silently do nothing. Keep both in sync.
  - Keep `run_worker_first` narrow. `true` would route every image, font and
    `dist/` bundle through the Worker for no benefit.
- ⚠️ **Diagnose with the `x-ssr-rooms` response header on `/`,** which every exit
  path stamps. **Absent** = the Worker never ran (routing). A **number** = cards
  rendered. `nokey` / `fetchfail` / `http4xx` / `badjson` / `nodata` / `error` =
  it ran and gave up there. Routing and data failures look identical in the HTML
  — both just leave an empty grid — and telling them apart by guesswork cost
  several deploy cycles before this header existed.
- The settings fetch prefers the `SUPABASE_ANON_KEY` binding but falls back to
  `PUBLIC_ANON_KEY` in `worker.js`. **The binding was in fact absent on the
  Worker**, which is why the first two attempts rendered nothing. That key is
  published in `index.html` already and every table it reaches is behind RLS, so
  the fallback is safe. ⚠️ The **service role** key is not in source and never
  may be.
- **The client still re-renders over it.** That is deliberate, not waste: the
  server copy is what a crawler indexes, the client pass keeps a long-open tab
  honest if a rate changes mid-session.
- ⚠️ **`worker.js` holds byte-identical copies of `escHtml`, `getSortedRooms`,
  `buildPublicRoomCardsHtml`, `ROOM_CAPACITY_NOUNS` and `ROOMS`.** It cannot
  import from `js/` — those are classic browser scripts with top-level side
  effects, and the pages load them unbundled in local dev. A **cross-file drift
  guard** in `js/tests/business-logic.test.js` fails CI if any copy diverges. It
  already earned its keep: it caught Summer Camp's rate and ratio being copied
  from the live settings instead of the source defaults. **Add a room, rename a
  room, or change the card markup → update both sides.**
- `renderPublicRoomCards()` in `js/app.js` was split so the string builder
  (`buildPublicRoomCardsHtml`) is pure and the DOM write is separate. Keep it
  that way — the guard compares that function.

⚠️ **The Owl and Turtle rooms both read "24 – 36 months" in the live
`room_rates` setting**, and Goose reads 36–60. That contradicts the Rooms table
below. Since these are now server-rendered, whatever is in Settings is what
Google indexes — fix it in Settings → Rates, not in code.

---

## ⚠️ Two staff lists, and the public one filters itself (2026-08-16)

**`staff` (the roster) and `settings.staff_directory` (the public "Our Staff"
cards) are separate and nothing linked them.** Marking an assistant director
inactive in Staff → Staff Roster left her on the home page indefinitely, with
nobody told. Found in production.

`public_staff_directory_rpc.sql`, **applied and verified 2026-08-16.**
`js/app.js` now calls `fetchPublicStaffDirectory()` → the
`public_staff_directory()` SECURITY DEFINER RPC, which does the join and returns
only what should be shown.

- ⚠️ **The browser cannot do this filtering.** The anon policy on `staff` is
  `USING (active = true)`, so anon sees *only* active staff and cannot tell
  "left the center" from "never in the roster". Widening that policy would
  publish a list of former employees — worse than the bug. **Do not replace the
  RPC call with `fetchSetting('staff_directory')`.**
- **The rule fails open:** shown if the roster does not know the person (a
  directory-only entry) **or** any matching roster row is active; hidden only
  when the roster knows them and no match is active. An unmatched entry is never
  hidden by accident.
- Names match loosely in one direction: the directory holds first names
  (`Mary Ellen`), the roster holds full names (`Mary Ellen Scheetz`), so a
  directory name matches a roster name it is a whole-word prefix of. Two staff
  sharing a first name is safe — the card shows while *either* is active.
- ⚠️ **`admin-settings.js` still reads the raw setting on purpose.** The editor
  must see every entry including hidden ones; loading the filtered list there
  would silently delete them on the next save.
- **The editor badges hidden rows** ("Not on website", gold rail, dimmed photo)
  so a hidden person is not indistinguishable from a shown one.
  `staff_directory_hidden_names.sql` (**applied 2026-08-16**) moved the rule into
  `_staff_directory_annotated()` and both callers now read it:
  `public_staff_directory()` filters on it, `staff_directory_hidden_names()`
  reports it. ⚠️ **Never re-derive "is this entry hidden" in JS** — two copies of
  the rule that drift would label the wrong people as off-site, which is worse
  than no badge. The badge is keyed on name, so the save handler re-fetches:
  renaming a row can change whether it matches the roster.
  - `_staff_directory_annotated()` has **no EXECUTE for anon or authenticated**;
    the two definer wrappers call it as owner. `staff_directory_hidden_names()`
    is `authenticated` only *and* self-gates on `is_admin()`, because R20 means
    the browser's role check cannot be trusted.
- Verified as `anon` in a rolled-back transaction: with the inactive employee
  re-inserted, the RPC returns 6 entries and does not leak her name.

---

## ⚠️ The `.insert().select()` trap — audited 2026-08-13

**This took parent registration down for ~6 hours on 2026-08-12.** Worth reading
before touching any anon write path.

RLS and column grants apply to `RETURNING`. So a supabase-js chain like
`.from('x').insert({...}).select()` needs **SELECT on x**, not just INSERT. When
R1 revoked anon's SELECT on `registrations`, `submitRegistration()` started
failing with `42501 permission denied for table registrations` and the insert
**never landed** — the whole statement aborts, so it fails silently-shaped: the
parent sees an error, nothing is written, and no partial row is left behind to
notice later.

The class was already documented here for the public waitlist form, and the same
bug then shipped into the registration path anyway. Documenting a trap does not
close it.

**Fixed** by `submit_registration(jsonb)` — SECURITY DEFINER, column allow-list,
`search_path` pinned, both inserts in one transaction, `month_key` computed
server-side. anon needs no SELECT on either table.

### Audit result (2026-08-13) — all 11 real chains

Only tables anon can INSERT but not SELECT are at risk. Every remaining
`.insert().select()` is on an admin path where `authenticated` holds SELECT
(verified against `has_table_privilege`, not assumed):

| Site | Table | Reached by | Safe because |
|---|---|---|---|
| `createFamily` | families | admin-families.js | authenticated has SELECT |
| `addDirectorTimeOff` | staff_time_off_requests | admin-portal.js | authenticated has SELECT |
| settings / staff / students / billing_* / cacfp_* | — | admin only | anon has no INSERT at all |

`addMessage` (Contact Us, genuinely anon) is a **bare** `.insert()` with no
`.select()`, so it is unaffected.

**Before granting/revoking anon SELECT on any table, grep for `.insert(` on it
first.** And when adding an anon write, prefer a definer RPC over a table grant.

### How the verification nearly lied, twice
- A blocked UPDATE under RLS returns **0 rows affected, not an error**. A probe
  that only catches exceptions reads a blocked write as a successful no-op.
  Count the rows.
- Verifying a write **as the role under test** fails when that role cannot read
  the table — the error looks like the function is broken when the test is.
  `reset role` before checking what was written.
