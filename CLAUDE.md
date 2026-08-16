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

**⚠️ STILL OPEN: `staff_clock_events` is the last permissive anon policy.**
SELECT/INSERT/UPDATE all `USING (true)`. Measured as `anon`:
`UPDATE staff_clock_events SET room_id = 'probe'` → **1547 rows**, no WHERE
needed. The public anon key can rewrite `clock_in`/`clock_out` across the whole
payroll history, and the SELECT exposes every staff member's hours. FS24 called
this "same-day cross-staff tampering"; it is the entire table. Cannot be fixed
by a revoke — the kiosk clock-out depends on that UPDATE (~1,280 calls). Needs a
PIN-gated definer clock-out RPC (same shape as `log_child_event`), after which
both policies can be dropped.

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

### Registration window
The window is defined by the `registration_window` setting. `app.js` gates the UI on it
and has a handler for the `P0001` error a database trigger would raise.

> **⚠️ NOT ACTUALLY ENFORCED SERVER-SIDE (R24, found 2026-08-02).**
> `enforce_registration_window.sql` was **never applied to production** — neither
> `check_registration_window()` nor the `enforce_registration_window` trigger exists
> in the live database (verified against `information_schema`). The `P0001` handler in
> `app.js:1383` can never fire. Since `anon` holds INSERT on `registrations`, the window
> is enforced **only by client-side JavaScript** and can be bypassed by anyone posting
> directly to the API. Apply the migration to make the documented behavior real.

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
