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
