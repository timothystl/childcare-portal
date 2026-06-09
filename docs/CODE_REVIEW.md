# Childcare Portal — Code Review

_Reviewed: 2026-06-04 · App version 1.15.8 · Branch `claude/kind-mendel-I79x6`_

> **Second sweep (2026-06-05):** a deeper Opus pass focused on correctness/logic bugs,
> data integrity, races, and edge-function/SQL security. New findings are in the
> **"Second Sweep — correctness & integrity"** section near the end (labels **SS1–SS19**),
> independent of the original S/U/V/N/P/Q/C/M items.

This is a read-only review. **No application code was changed** — findings are
prioritized recommendations for the team to triage. Each finding is tagged by surface:
**[Admin]** (admin portal), **[Public]** (parent-facing site), or **[Both]**.

> **Reading the security section:** Much of the auth/RLS surface lives in the live
> Supabase project, not in this repo. Where a finding depends on the live project it is
> marked **[verify in Supabase]** — treat it as "confirm this" rather than a confirmed
> defect.

---

## Summary table

| # | Sev | Surface | Area | Finding | Location |
|---|-----|---------|------|---------|----------|
| S1 | High | Both | Security | RLS coverage on core PII tables unconfirmed | migrations / Supabase |
| S2 | High | Admin | Security | Admin role enforced client-side only (CSS hiding) | admin-settings.js, admin-core.js |
| S3 | Med | Admin | Security | Permissive role fallback on unknown role string | admin-core.js:114 |
| S4 | Med | Admin | Security | `admin-users` edge fn only checks `=== 'full'` | functions/admin-users |
| S5 | Med | Both | Security | Inconsistent HTML escaping (XSS surface) | js/admin/*.js |
| S6 | Med | Public | Security | PIN-reset throttling per-family only, no per-IP/CAPTCHA | functions/request-pin-reset |
| S7 | Low | Public | Security | Family-login RPC returns lockout flags / all parent2 fields | hash_family_pins.sql |
| S8 | Low | Both | Security | Anon-key expiry / rotation plan | js/supabase.js |
| U1 | High | Both | UX/a11y | No `:focus` styles on buttons/tabs/links/cells | css/styles.css |
| U2 | Med | Both | UX/a11y | Sparse `aria-label`/alt on icon & emoji controls | *.html |
| U3 | Med | Both | UX/a11y | No loading/disabled/error states for async actions | css/styles.css |
| U4 | Med | Both | UX/a11y | Responsive gaps; admin grids overflow on mobile | css/admin.css, styles.css |
| U5 | Med | Public | UX | Day-picker popup positioned off-screen on mobile | js/app.js:648 |
| U6 | Med | Public | UX | Silent PIN-reset success even on send failure | js/supabase.js:799 |
| U7 | Low | Public | UX | Lookup hides non-visible months with no explanation | js/lookup.js:118 |
| V1 | High | Both | Style | Hardcoded hex bypasses design tokens | css/admin.css, styles.css |
| V2 | High | Public | Style | ~300 inline `style=` attributes (some raw hex) | index/calendar/lookup.html |
| V3 | Med | Both | Style | Multiple ad-hoc shades of each brand color | all CSS |
| V4 | Low | Both | Style | `:root` palette + font imports duplicated 4–5× | *.html |
| V5 | Low | Both | Style | Duplicate `.btn-*` rules in two CSS files (drift) | styles.css, admin.css |
| V6 | Low | Both | Style | No typography scale | all CSS |
| N1 | Low | Both | Naming | Minor JS naming outliers (acceptable) | js/ |
| P1 | Med | Public | Perf | Full calendar re-render via per-cell appendChild | js/app.js:520 |
| P2 | Med | Public | Perf | Redundant billing recomputation (O(n²)) | js/app.js:721 |
| P3 | Low | Public | Perf | Capacity lookups per cell, uncached | js/app.js:449 |
| P4 | Low | Both | Perf | `escHtml` does 5 sequential `.replace()` | js/supabase.js:2241 |
| Q1 | Med | Public | Quality | Duplicated billing calc logic (2 call sites) | js/app.js:1160 vs 721 |
| Q2 | Med | Both | Quality | Inconsistent JSON-parse error handling | js/supabase.js (multiple) |
| Q3 | Med | Public | Quality | Init side-effects run serially, no error handling | js/app.js:75 |
| Q4 | Low | Both | Quality | Duplicate `MONTH_NAMES` / month formatting | app.js, lookup.js |
| Q5 | Low | Public | Quality | `escStr = escHtml` aliases add no value | app.js:1307, lookup.js:330 |
| C1 | Med | Public | Comments | Pricing/discount logic undocumented | js/app.js:721,749 |
| C2 | Med | Public | Comments | Registration-window/timezone logic undocumented | js/app.js:30-70 |
| C3 | Low | Both | Comments | `friendlyError` swallows root cause silently | js/supabase.js:279 |
| M1 | Med | Both | Maint | `js/supabase.js` is a 2,497-line god-file | js/supabase.js |
| M2 | Low | Both | Maint | Inconsistent input normalization (email/PIN) | app.js:191, lookup.js:53 |

Severity counts: **High 4 · Medium 16 · Low 16.**

---

## A. Security — [Both; mostly Admin/backend]

> **Context on RLS:** Row Level Security **is** enabled on many tables — `billing_*`,
> `staff_schedules`, `admin_audit_log`, `deletion_requests`, `client_error_log`,
> `attendance_summary`, `billing_summary`, `pin_reset_tokens`. The core tables
> `families`, `students`, `registrations`, and `staff` have **no RLS statements anywhere
> in `supabase/migrations/`**. They were almost certainly created directly in the
> Supabase dashboard, so their RLS status cannot be confirmed from this repo — it must
> be checked in Supabase.

### S1 — [High · verify in Supabase] RLS on core PII tables
The anon key ships in the browser (`js/supabase.js`). If RLS is **off** on `families`,
`students`, `registrations`, or `staff`, any visitor can enumerate parent emails/phones,
child names and DOBs, and staff records straight from the REST endpoint.

**Verify:**
```sql
select relname, relrowsecurity
from pg_class
where relname in ('families','students','registrations','staff','registration_dates');
```
Every row should show `relrowsecurity = true`. If not, enable RLS and add policies so
these tables are reachable only through the authenticated admin role or the existing
PIN-gated `family_login()` RPC — never via the bare anon key.

### S2 — [High] Admin role enforced client-side only
`js/admin/admin-settings.js` (~564–597) hides tabs with `display:none` based on
`currentAdminRole`. A `restricted` or `staff` admin can unhide tabs in DevTools or call
admin functions directly from the console. Client gating is **UX only** unless the
server also enforces it.

**Recommendation:** Enforce role server-side for every privileged mutation — via RLS
policies keyed on the caller's email/role, or by routing privileged writes through edge
functions that re-check the role. Keep the client gating for convenience, but do not
rely on it as a security boundary.

### S3 — [Medium] Permissive role fallback
`js/admin/admin-core.js:114`:
```js
currentAdminRole = roles[email] || (hasRules ? 'staff' : 'full');
```
A misspelled key in the `admin_roles` settings object (e.g. `"restriced"`) yields
`undefined` and falls through. Validate against an explicit allow-list and default to
the **least** privilege:
```js
const VALID_ROLES = ['full', 'restricted', 'staff'];
const raw = roles[email];
currentAdminRole = VALID_ROLES.includes(raw) ? raw : (hasRules ? 'staff' : 'full');
if (raw && !VALID_ROLES.includes(raw)) console.warn('Unknown admin role:', raw);
```

### S4 — [Medium] `admin-users` edge function authorization — ✅ CLOSED (2026-06-05)
`admin-users` (service-role create/delete of admin accounts) skips its role check when
`admin_roles` is empty, so any **authenticated Supabase Auth user** could create a full
admin. The exploit required public **Supabase Auth sign-ups** to be enabled — and they
were. The app never uses signup (parents auth via the `family_login` PIN RPC; admins are
created via the service-role Admin API, which bypasses the signup toggle; zero `signUp`
calls in code), so **sign-ups were disabled in the dashboard**, closing the takeover path.
_Residual (optional, defense-in-depth):_ make the function **fail closed** (always require
`roles[callerEmail] === 'full'`) so it doesn't depend on the toggle — needs `admin_roles`
populated first (or an env-var bootstrap allowlist) to avoid lockout.

### S5 — [Medium] Inconsistent HTML escaping (stored XSS surface)
`escHtml()` (`admin-core.js` / `js/supabase.js:2241`) exists but isn't applied to every
DB-sourced value interpolated into `.innerHTML` across `js/admin/*.js` (family names,
emails, child names, form descriptions). A child or family name like
`<img src=x onerror=...>` would execute in the admin dashboard.

**Recommendation:** Audit every `.innerHTML =` that interpolates DB data and wrap
user-controlled fields in `escHtml()` (or build with `textContent`). Consider adding a
Content-Security-Policy header to blunt the impact.

### S6 — [Medium] PIN-reset throttling
`supabase/functions/request-pin-reset` rate-limits per family (~15 min) but has no
per-IP limit or CAPTCHA, allowing email spam toward families and account enumeration.
Add per-IP throttling and/or a CAPTCHA, plus a per-family daily cap.

### S7 — [Low] Family-login RPC over-returns
`family_login()` (`hash_family_pins.sql`) returns lockout flags (`login_locked`,
`registration_locked`) and all `parent2_*` fields. Trim the RPC projection to what the
parent client actually needs; lockout state is admin information.

### S8 — [Low] Anon-key lifetime
Confirm the anon JWT has a reasonable expiry and document a rotation cadence (e.g.,
annually). Long-lived keys widen the blast radius if leaked.

---

## B. UX & Accessibility — [Both]

### U1 — [High] Missing focus indicators
Only form inputs have `:focus` styles (`css/styles.css`). Buttons (`.btn-primary`,
`.btn-secondary`, `.btn-ghost`), admin/lookup tabs, calendar day cells, and links have
none — keyboard users can't see focus. Fails WCAG 2.4.7. Add a consistent visible focus
ring:
```css
.btn-primary:focus-visible, .btn-secondary:focus-visible, .btn-ghost:focus-visible,
.admin-tab-btn:focus-visible, .lookup-tab:focus-visible,
.calendar .cal-day:focus-visible, a:focus-visible {
  outline: 2px solid var(--sun);
  outline-offset: 2px;
}
```

### U2 — [Medium] Sparse ARIA / alt text
Only ~22 `aria-*` attributes across the HTML. Icon-only buttons, modal close (`×`)
buttons, and emoji-as-icon placeholders (e.g. gallery `📷` in `index.html`) lack
labels. Add `aria-label` to icon controls and `aria-hidden="true"` to decorative emoji.

### U3 — [Medium] No async feedback states
The modal/toast styles have no loading, disabled, or error states. During Supabase
calls there's no spinner and submit buttons aren't visibly disabled — users can
double-submit. Add `button:disabled` styling, a spinner state, and a toast entry
animation.

### U4 — [Medium] Responsive gaps
Breakpoints are inconsistent (600px in `styles.css`, 520px in `lookup.css`, none in
`admin.css`). The admin `.family-students` grid uses a fixed multi-column template that
overflows on phones. Standardize breakpoints, collapse admin grids to single column on
small screens, and add `-webkit-overflow-scrolling: touch` + a scroll affordance to
`.table-wrapper`.

### U5 — [Medium] Day-picker off-screen on mobile — [Public]
`js/app.js:648-651` positions the day picker at a fixed 50%/50%, which can render
off-screen on small viewports. Position relative to the clicked cell via
`getBoundingClientRect()`, clamped to the viewport.

### U6 — [Medium] Silent PIN-reset success — [Public]
`js/supabase.js:799-804` swallows fetch errors and always shows success, so a parent
believes the reset email was sent even when delivery failed. Surface failures (log via
`error-monitor.js` and suggest contacting the office).

### U7 — [Low] Lookup hides months silently — [Public]
`js/lookup.js:118-144` shows only current+next month with no note that other months
exist, which can look like data loss. Add a hint when hidden registrations exist.

---

## C. Visual style — colors & fonts — [Both]

### V1 — [High] Hardcoded hex bypasses design tokens
Brand colors are re-typed as literals throughout `css/admin.css` and `css/styles.css`:
`#1F5278` (table header), `#2a6490` (hover), `#1a5c3e` (15+×), `#7a5a00` (8+×),
`#fffbe6`, `#fef3c7`, `#f2b89a`, etc. Define a complete light→dark token set in `:root`
and replace literals with `var(--…)` so rebrand/theming is a one-file change.

### V2 — [High] ~300 inline `style=` attributes — [Public]
`index.html`, `calendar.html`, and `lookup.html` carry hundreds of inline styles, some
embedding raw hex (e.g. the "Coming Soon" badge mixes `#fef3c7`/`#92400e`/`#fcd34d`).
Move these into CSS classes for maintainability and CSP-friendliness.

### V3 — [Medium] Ad-hoc shade proliferation
Each brand family has multiple un-tokenized shades (greens `#5BAD8B`/`#C9E6DC`/`#C8EADC`
/`#1a5c3e`/`#2d6b52`; navies `#01294A`/`#013d6b`/`#1F5278`/`#2a6490`; suns/golds; tangs).
Pick one canonical palette with named light→dark steps.

### V4 — [Low] Duplicated `:root` palette & font imports
The brand palette and font imports are repeated inside `<style>` blocks in 4–5 HTML
files (index/calendar/enroll/clockin). Extract to a shared `css/variables.css` linked by
every page.

### V5 — [Low] Duplicate button rules
`.btn-secondary` and `.btn-ghost` are defined in **both** `styles.css` and `admin.css`
with diverging padding/font-size. Keep one canonical definition; admin.css should hold
only true overrides.

### V6 — [Low] No typography scale
Font sizes/weights are chosen ad hoc (e.g. `.btn-secondary` weight 800 vs 600 elsewhere;
labels `.85em`–`1em`). Introduce a small scale of size/weight variables.

---

## D. File-naming conventions — [Both]

### N1 — [Low] Mostly consistent; minor notes
HTML is kebab-case; `js/admin/*` and root helpers (`build-version.js`,
`error-monitor.js`, `push-notifications.js`, `reset-pin.js`) are kebab-case; CSS is
lowercase. The only outliers are `app.js`, `lookup.js`, and `supabase.js` (no hyphen) —
acceptable conventional names. No stray/backup/duplicate files found. No action needed
beyond awareness.

---

## E. Performance — [mostly Public, some Both]

### P1 — [Medium] Full calendar re-render via per-cell `appendChild`
`renderCalendar()` (`js/app.js:520-574`) builds 25+ cells with individual `appendChild`
calls and re-runs on every date click / month change / time change. Build a
`DocumentFragment` or HTML string and insert once; cache static day headers.

### P2 — [Medium] Redundant billing recomputation (≈O(n²))
`getChildDayAmounts()` is recomputed multiple times per render
(`js/app.js:721-790`): `calcTotal()` → `calcDayTotal()` → `getChildDayAmounts()`, each
re-sorting and re-deriving discounts across `selectedChildren`. Memoize the per-dayType
result and reuse it.

### P3 — [Low] Uncached capacity lookups per cell
`spotsLeft()` / `getDateStatus()` (`js/app.js:449-481`) run per calendar cell against
`capacityCache`. Compute results once in `renderCalendar()` and pass them into the badge
logic.

### P4 — [Low] `escHtml` does five sequential replaces
`js/supabase.js:2241-2248` rescans the string five times and is called 40+ times. Use a
single `/[&<>"']/g` replace with a character-map lookup.

---

## F. Code quality, comments & maintainability — [Both]

### Q1 — [Medium] Duplicated billing calc — [Public]
Submission code (`js/app.js:1160-1170`) re-implements the discount logic from
`renderSelectedDates()` (`~721-733`). Extract one
`calculateChildAmounts(selectedChildren, dayType)` used by both, so pricing rules live
in a single place.

### Q2 — [Medium] Inconsistent JSON-parse error handling
`js/supabase.js` mixes silent `try { JSON.parse } catch { default }`
(lines ~1260, 1387, 1831, 1897, 1918) with throwing elsewhere. Standardize on a
`parseJsonSafe(raw, fallback)` helper.

### Q3 — [Medium] Serial init with no error handling — [Public]
`DOMContentLoaded` (`js/app.js:75-127`) awaits `loadRateSettings()`,
`loadSummerCampSetting()`, `fetchSetting()`, `fetchClosures()` in series with no
guards; one failure leaves the form partially initialized. Use `Promise.allSettled()`,
log failures, and degrade gracefully.

### Q4 — [Low] Duplicate month constants/formatting
`MONTH_NAMES` is declared in both `app.js:4-5` and `lookup.js:9-12`, and month-label
formatting is duplicated. Define once in `supabase.js` and reuse.

### Q5 — [Low] No-op aliases
`const escStr = escHtml;` (`app.js:1307`, `lookup.js:330`) adds indirection without
value — use `escHtml` directly.

### C1 — [Medium] Pricing logic undocumented — [Public]
`calcTotal()` (`js/app.js:749`) and `getChildDayAmounts()` (`~721`) drive billing but
lack JSDoc for week grouping, discount stacking, sort rationale, and output shape.
Financial logic deserves explicit documentation for the next maintainer.

### C2 — [Medium] Registration-window logic undocumented — [Public]
`getCentralTimeNow()` / `getRegistrationWindow()` / `getTargetMonthKey()`
(`js/app.js:30-70`) implement CST/CDT-aware deadline math with no comments. Add JSDoc
explaining the timezone handling and deadline derivation.

### C3 — [Low] `friendlyError` hides root cause
`js/supabase.js:279-286` collapses HTML responses, 522s, and timeouts into "Cannot reach
database," discarding the real error. Keep the friendly UI message but log the raw error
for diagnosis.

### M1 — [Medium] `js/supabase.js` god-file
At ~2,497 lines it mixes capacity, closures, registrations, families, messages, staff,
billing, and audit logging. Split into focused modules
(`supabase-registrations.js`, `supabase-families.js`, `supabase-billing.js`, …) to ease
navigation, testing, and merges.

### M2 — [Low] Inconsistent input normalization
Email/PIN inputs (`app.js:191-192`, `lookup.js:53-54`) are format-checked but not
trimmed/lower-cased; a case-mismatched email can fail lookup. Normalize email to
lower-case and trim before lookups.

---

## Remediation order (execution checklist)

Items keep their finding labels for reference. Check off as completed.

### Wave 1 — Security must-dos
- [~] **S1 — [HIGH, confirmed exposure].** RLS is enabled, but policy review (2026-06-05)
  found **over-permissive `USING (true)` anon/public policies**: anon SELECT+UPDATE on
  `families`, anon SELECT+UPDATE+DELETE on `students`, public/anon SELECT on `staff`
  (exposes `salary_biweekly`/`hourly_rate`), and anon SELECT on `registrations`/
  `registration_dates`. The anon key ships in the browser → anyone can dump parent/child
  PII + staff pay, and tamper with/delete family & student records.
  **Code-verified:** no non-admin JS/HTML uses families/students/staff directly (parent
  flows use service-role edge fns + definer RPCs), so those policies are vestigial.
  - **Tier 1 (safe drops): migration written** → `supabase/migrations/tighten_anon_rls_policies.sql`
    (drops the families/students/staff anon-SELECT/UPDATE/DELETE policies). Test in staging.
  - **Tier 2:** `registrations`/`registration_dates` anon SELECT are load-bearing
    (dup-check + capacity) — move those into `SECURITY DEFINER` RPCs, then drop. Ties into
    the registration-RPC work (SS3/SS5/SS9).
- [ ] **S2** — Enforce admin role server-side (RLS/edge fn), not just CSS hiding — _deferred: architectural, needs live Supabase to test_
- [x] **S3** — Validate role against `['full','restricted','staff']` enum, least-privilege default — `admin-core.js`
- [x] **S4** — ✅ Closed by disabling public Supabase Auth sign-ups (app never used signup; admins are created via the service-role Admin API). Optional defense-in-depth: still make the edge fn fail-closed.
- [x] **S5** — Audit `js/admin/*` `.innerHTML` sites — escaping was consistent except one gap (roster child name), now `escHtml()`-wrapped in `admin-classrooms.js`

### Wave 2 — Quick UX wins
- [x] **U1** — Visible `:focus-visible` rings on buttons/tabs/links/cells — `css/styles.css`
- [~] **U3** — Disabled-button states already exist (`styles.css:456,872`); disable-on-submit JS wiring still TODO
- [x] **U6** — Surface PIN-reset send failures (`requestPinReset` now returns `res.ok`) — `js/supabase.js`
- [x] **U5** — _False positive:_ day-picker is already viewport-centered (240px, fixed + translate). Moved redundant inline positioning into CSS (`styles.css` / `app.js`)
- [x] **U2** — Added `aria-label="Close"` to icon-only modal close buttons (`admin.html`) and `aria-hidden` to decorative gallery emoji (`index.html`)

### Wave 3 — Remaining security/UX polish
- [ ] **S6** — Per-IP / CAPTCHA throttling on PIN reset
- [ ] **S7** — Trim `family_login()` RPC projection
- [ ] **S8** — Confirm anon-key expiry + rotation cadence
- [ ] **U4** — Standardize breakpoints; fix admin grid mobile overflow
- [x] **U7** — ✅ Lookup now notes confirmed days in other (hidden) months and only shows children with visible days (`js/lookup.js`, `css/lookup.css`)

### Wave 4 — Design system
- [~] **V1** — Tokenized the brand-derived dark/badge colors (`--navy-table`, `--green-dark`, `--mustard-dark`, `--tang-dark`, `--amber-dark`, `--sun-badge`, `--sun-edit`, `--tang-soft`) — ~90 literals replaced, value-preserving. Generic grays / semantic Tailwind-ish colors deferred to V3 (naming is a design decision)
- [ ] **V4** — Extract shared `css/variables.css`, dedupe `:root`/fonts
- [ ] **V5** — Consolidate duplicate `.btn-*` rules
- [ ] **V2** — Migrate ~300 inline `style=` to CSS classes
- [ ] **V3** — Collapse ad-hoc shades to canonical palette
- [ ] **V6** — Typography scale variables

### Wave 5 — Quality, perf & maintainability
- [x] **Q1** — Parameterized `getChildDayAmounts(dayType, children=selectedChildren)` and replaced the duplicated `calcSubmitDayAmounts` in the submit flow with a call to it — billing math now lives in one place (`app.js`)
- [x] **C1** — JSDoc on `getChildDayAmounts` documenting the two discount layers + return shape (`app.js`); the other pricing fns already had inline comments
- [~] **C2** — Already partly covered: `app.js` has a window/timezone comment block (lines 24-29) and inline notes; no new code needed
- [ ] **P2** — Memoize redundant billing recomputation
- [ ] **P1** — Build calendar via fragment/string, render once
- [ ] **P3** — Cache per-cell capacity lookups
- [x] **M2** — _Already handled:_ the `family_login` RPC matches with `lower(parent_email) = lower(p_email)`, so email is case-insensitive server-side; input is already trimmed. No change needed
- [x] **C3** — `friendlyError` now logs the raw cause before returning the friendly message (`supabase.js`)
- [x] **P4** — `escHtml` rewritten as a single `/[&<>"']/g` replace with a char map (`supabase.js`)
- [x] **Q2** — Added `parseJsonOr(str, fallback)` and replaced 6 identical inline `try/JSON.parse/catch` idioms (`supabase.js`), value-preserving
- [x] **Q3** — Init fetches now run via `Promise.allSettled` with per-fetch error logging and graceful degradation (`app.js`)
- [x] **Q4** — One shared `MONTH_NAMES` in `supabase.js`; removed duplicates from `app.js`, `lookup.js`, `admin-core.js`, `admin-finance.js`, `admin-billing.js` (and all `MONTH_NAMES_ADMIN`/`_FIN`/`BL_` references)
- [x] **Q5** — Removed `escStr`/`escLookup` aliases; call sites use `escHtml` directly (`app.js`, `lookup.js`)
- [ ] **M1** — Split `js/supabase.js` god-file into modules
- [ ] **N1** — File naming — no action (note only)

---

# Second Sweep — correctness & integrity (SS)

A deeper pass (three parallel Opus reviewers, cross-verified) focused on real defects
rather than style. None duplicate the S/U/V/N/P/Q/C/M items above. Items marked
**[verify in Supabase]** depend on the live DB schema. "In-repo fix" = fixable in this
repo without touching the live Supabase project.

## High

- **SS1 — [High] Weekly-rate quote vs charge divergence (overcharge).** [Public] The
  preview (`calcTotal`, `js/app.js:763`) applies a room's full-week weekly rate, but the
  submit/receipt/email/invoice path (`js/app.js:~1173`) sums per-day via
  `getChildDayAmounts` and never applies the weekly rate. When an admin has set
  `weeklyFullRate`/`weeklyHalfRate` (default `null`, so currently dormant), a family is
  quoted e.g. $300 but charged/invoiced 5×$75=$375. _In-repo fix:_ share the
  week-grouping/weekly-rate logic between both paths.
- **SS2 — [High] ✅ FIXED (2026-06-05).** Leading-zero PIN lockout. `family_login` now
  takes a TEXT PIN (`ss2_family_login_text_pin.sql`, applied); `parseInt` dropped in
  `js/supabase.js` `familyLogin` and the `family-lookup` edge fn (both deployed). Verified
  a `0`-leading PIN logs in. (Staff PINs are a separate int system — still SS11 territory.)
- **SS3 — [High] No server-side capacity enforcement (oversubscription race).** [Public]
  Capacity is checked only client-side against a cache; `submitRegistration`
  (`js/supabase.js:386`) inserts with no count re-check and no DB trigger/constraint exists.
  Two parents (or a direct REST call) can both book the last spot. _Fix:_ enforce in a DB
  trigger or atomic RPC.
- **SS4 — [High] ✅ FIXED (deploy edge fn).** `send-waitlist-offer` now requires a valid
  admin session (mirrors `send-schedule-change`); anonymous callers get 401
  (`supabase/functions/send-waitlist-offer/index.ts`). _Redeploy via `supabase functions
  deploy send-waitlist-offer`._ (Link allow-listing still recommended; other `send-*` audited.)
- **SS5 — [High] Billing RPCs granted to `anon` with caller-supplied email + amount.**
  `create_billing_invoice_by_email`/`add_day_to_invoice_by_email` (`add_billing_rpc.sql`)
  trust a client email and dollar amount — any visitor can zero out or inflate any family's
  draft invoice. _Fix:_ revoke `anon`; compute amounts server-side.
- **SS6 — [High, verify in Supabase] ✅ FIXED.** Finance modeling queried a non-existent
  `month` column; `fetchEnrollmentByRoomForMonths` now uses `month_key`
  (`js/supabase.js:2125`). _Still verify the live `registrations` schema has `month_key`._
- **SS7 — [High] ✅ FIXED.** Staff "Save" button stayed disabled after the first save;
  `closeStaffForm()` now resets it (`js/admin/admin-staffing.js`).

## Medium

- **SS8 — [Med] ⚠️ WON'T FIX without a product decision.** The
  `(lower(child_name), month_key)` index is intentional per the documented rule
  (`checkExistingRegistrationByChild` blocks *any* parent from re-registering a child
  already scheduled that month). Scoping by family would re-allow that double-registration.
  Real tension: it also false-positives on two genuinely different children sharing a name.
  _Decide:_ keep the strict name rule, or accept duplicate-child risk for fewer false
  positives. Not changed.
- **SS9 — [Med] Non-atomic registration insert → orphaned `registrations`.** [Public] If the
  dates insert fails and the compensating delete also fails (`js/supabase.js:432`), a
  confirmed registration with zero dates blocks re-registration. _Fix:_ one transactional RPC.
- **SS10 — [Med] ✅ FIXED (apply migration).** `ALTER FUNCTION … SET search_path = public`
  for the three billing RPCs + `check_registration_window` —
  `supabase/migrations/harden_definer_search_path.sql` (non-invasive; no body rewrite).
- **SS11 — [Med] Staff PIN brute-forceable; kiosk lockout client-side only.**
  `lookup_staff_by_pin` has no server-side throttle; the lockout is `sessionStorage`
  (`clockin.html`), bypassable via direct RPC → 10⁴ brute force → payroll fraud + PII leak.
  _Fix:_ server-side throttling; longer PINs.
- **SS12 — [Med] No DB guard against overlapping open clock-ins.** Two tabs/taps insert two
  `clock_out IS NULL` rows for the same staff+date; hours double-count. _Fix:_ partial unique
  index `(staff_id, work_date) WHERE clock_out IS NULL` or clock via RPC.
- **SS13 — [Med] ✅ FIXED (deploy edge fn + worker).** Strict email-format validation now
  runs before the `.or(...ilike...)` filter in `send-schedule-confirmation/index.ts` and
  `worker.js` (the regex rejects `, ( ) *` — note `encodeURIComponent` did NOT escape `*`).
  _Redeploy the function and the worker._
- **SS14 — [Med] ✅ FIXED.** Infant recurring-days note showed "none" from the Calendar tab;
  now falls back to `fetchStudentRecurringDays` when the family isn't cached
  (`admin-calendar.js`).
- **SS15 — [Med] ✅ FIXED.** "Room Today" selector now shows a read-only multi-room label
  (using the previously-dead `roomMap`) instead of letting a single-room edit overwrite a
  staffer's other-room events (`admin-staffing.js`).

## Low

- **SS16 — [Low] `login_attempts` never decays** (`finalize_pin_hashing.sql:71`) — 5 fumbles
  = permanent lockout pending email reset. _Fix:_ cooldown decay.
- **SS17 — [Low] Clock-out RLS keyed on `work_date = CURRENT_DATE` vs browser-derived date** —
  cross-midnight clock-outs rejected, shifts left open. _Fix:_ server-side America/Chicago
  date; key RLS on row id + staff.
- **SS18 — [Low] `pin_reset_tokens` cleanup never scheduled; consume leaks lifecycle.** _Fix:_
  schedule `cleanup_pin_reset_tokens()`; collapse consume errors to one generic message.
- **SS19 — [Low] Weekly discount lost on partial/closure weeks (policy).** [Public]
  `isFullWeek = days.length === 5` (`js/app.js:776`). _Decide policy_ and apply it identically
  in preview and submit (ties into SS1).

_Checked and cleared (no bug):_ the family-session HMAC token **is** verified server-side in
`worker.js` before push-subscribe; `consume_pin_reset` is atomic (`FOR UPDATE`);
`push_subscriptions` RLS is service-role only; `send-schedule-change` enforces admin auth;
`getWeekMonday`'s UTC `toISOString` is safe for US-Central; `getRegistrationWindow`/
`getTargetMonthKey` rollovers are correct; the sibling-discount math is correct; and this
branch's refactors introduced no regressions or namespace collisions.
