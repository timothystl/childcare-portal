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
- [x] **U3** — ✅ Already implemented (verified 2026-06-05): every parent-facing async button
  (registration submit, email+PIN lookup, contact form, forgot-PIN, portal login, reset-PIN)
  disables during its request and re-enables via `finally`/error paths. Original item was a
  false positive — no change needed.
- [x] **U6** — Surface PIN-reset send failures (`requestPinReset` now returns `res.ok`) — `js/supabase.js`
- [x] **U5** — _False positive:_ day-picker is already viewport-centered (240px, fixed + translate). Moved redundant inline positioning into CSS (`styles.css` / `app.js`)
- [x] **U2** — Added `aria-label="Close"` to icon-only modal close buttons (`admin.html`) and `aria-hidden` to decorative gallery emoji (`index.html`)

### Wave 3 — Remaining security/UX polish
- [ ] **S6** — Per-IP / CAPTCHA throttling on PIN reset
- [ ] **S7** — Trim `family_login()` RPC projection
- [ ] **S8** — Confirm anon-key expiry + rotation cadence
- [~] **U4** — Low priority (per owner, 2026-06-05): admin is used on **desktop only**, so the
  admin-grid overflow doesn't matter in practice. The only real mobile surface is the parent
  **calendar/registration** page (well-tested). Handle reactively if a parent reports an issue.
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

---

# Third Sweep — waitlist/inquiry funnel & Q3 diff (2026-07-11)

_Reviewed: 2026-07-11 · App version 1.20.2 · covers `d497c73..HEAD` (128 commits,
~7,300 insertions / 3,000 deletions since the second sweep above)._ This window
shipped the entire parent-facing waitlist/inquiry funnel (inquiry form →
confirm-interest → `waitlist-status.html`), a full rewrite of the admin Waitlist
& Capacity Planner, the Staff Directory (photos) feature, and the Billing→Finance
consolidation with ProCare import. None of it had been reviewed —
`docs/WAITLIST_STATUS.md` (written 2026-07-10) explicitly flagged itself as
"not yet code-reviewed" and asked the next reviewer to check specific things;
this sweep answers those and covers the rest of the diff. Labels continue as
**T1–T12** (High → Low), independent of S/U/V/N/P/Q/C/M and SS1–SS19 above.
Findings were produced by three parallel focused reviews (edge functions/
migrations/CI; the waitlist/inquiry funnel; app.js billing + staff directory +
finance) and the top items were independently re-verified by reading source and
the relevant commit history rather than taken on trust.

**Carried-over item status:** SS1 is now **fixed** (preview and submit both route
through the new single `buildBillingBreakdown()`). SS19, SS3, and SS9 are
**still open, untouched** in this window. SS13 should be **reopened as
incomplete** (see T1).

## High

- **T1 — [High] `send-schedule-confirmation` has no auth check; trusts fully
  client-supplied billing data.** [Public] The POST handler
  (`supabase/functions/send-schedule-confirmation/index.ts`) has no
  authentication/session check at all — confirmed by grepping the file for
  `Authorization`/`auth.role`; the only match is the *outbound* Resend API call.
  It's invoked from the browser with the bare anon key. `parentEmail`,
  `childNames`, `dates[].amount`, and `grandTotal` are all client-supplied and
  never cross-checked against real `registrations`/billing rows before being
  emailed — as a real-looking invoice with PDF attachment — to `parentEmail`.
  Anyone who knows or guesses a real family's email can POST fabricated
  dates/amounts and have a legitimate-looking "Timothy Lutheran MDO" invoice
  land in that family's inbox. _Also reopens **SS13**:_ its email-validation
  regex (`/^[^\s,()*@]+@[^\s,()*@]+\.[^\s,()*@]+$/`) blocks `,()* ` but not
  `%`/`_`, the actual Postgres `ILIKE` wildcards — `%@a.co` still passes
  validation and turns the `.or(...ilike...)` filter into a domain-wide
  enumeration query. Same regex is duplicated in `worker.js`. _Fix:_ require a
  valid admin session (mirror `send-schedule-change`/`send-waitlist-offer`),
  recompute amounts server-side instead of trusting the request body, and
  exclude `%`/`_` from the email-validation regex everywhere it's duplicated.
  Note CLAUDE.md itself still says this function "needs deploying" — confirm
  what's actually live before triaging urgency.
- **T2 — [High] Admin message inbox deleted; two live features now write into
  a black hole.** [Both] `js/admin/admin-messages.js` was deleted by commit
  `89cb987` (2026-07-01), dropping the admin UI/DB helpers for reading the
  `messages` table (confirmed: `messagesList`/`fetchMessages`/`markMessageRead`/
  `unreadBadge` no longer exist anywhere in `js/`). The write-only `addMessage()`
  survives and is still called by the calendar page's "Contact Us" button
  (pre-existing) **and** the brand-new "Message the Office" button on
  `waitlist-status.html` (shipped nine days later, 2026-07-10, whose own doc
  describes reusing "the existing Contact-Us pipeline" without noting the reader
  is gone). No email/notification trigger exists on `messages` either. Net
  effect: messages parents send today are saved where no one in the admin
  dashboard can see them. _Fix:_ restore a minimal admin message viewer, or
  route `addMessage()` through a staff email notification instead. Looks like an
  accidental compounding of two unrelated changes — confirm with the product
  owner, but treat as a bug until confirmed otherwise.
- **T3 — [High] ✅ FIXED and deployed (2026-07-11).** `waitlist-status` edge
  function ignored admin capacity overrides. [Public]
  `supabase/functions/waitlist-status/index.ts:340-349`
  gates on `typeof capRes.data.value === 'object'`, but `settings.value` is a
  TEXT column holding a JSON string, not jsonb — confirmed via commit
  `6e9977c`'s own message/diff, which fixed this *exact* bug in
  `send-waitlist-confirmation` and `send-waitlist-reminders` the same day
  ("the column is actually text... silently never being read") but never
  touched `waitlist-status/index.ts`, which has the identical pattern. The
  `typeof === 'object'` check on a string is always false, so `capacities` is
  always `{}` and the function silently falls back to hard-coded default room
  capacities. When an admin raises a room's capacity in Settings, the admin
  Planner reflects it immediately but `waitlist-status.html` keeps computing
  position/wait-estimate against the stale hard-coded number — exactly the
  parent-vs-admin discrepancy `docs/WAITLIST_STATUS.md`'s own review checklist
  asks the reviewer to catch. _Fixed:_ added the same `parseSettingsValue()`
  helper already proven in commit `6e9977c` and applied it to this function's
  `room_capacity` read; owner deployed the updated function via the Supabase
  dashboard on 2026-07-11. _Recommended follow-up:_ run the
  `docs/WAITLIST_STATUS.md` manual check (change a room's capacity in
  Settings → Capacity, confirm `waitlist-status.html`'s position/wait-estimate
  for a real waitlisted child in that room moves accordingly) to confirm the
  fix behaves correctly live, not just that it deployed without error.
- **T4 — [High] Admin "position" (global/cross-room) vs. parent "position"
  (per-room) — will disagree.** [Both] Admin's Queue tab
  (`js/admin/admin-waitlist.js:480-484`) ranks every waitlisted child across
  *all* rooms combined and shows that as "position." The edge function
  (`waitlist-status/index.ts:363-367`) ranks within the child's own room only,
  matching the documented design intent but not what the admin UI displays. A
  sibling with an early per-room rank in a less-competitive room can show as
  e.g. `_pos = 4` globally in the admin Queue view while their own parent status
  page says `#1 of 5` — staff quoting the admin number on the phone will
  contradict what the parent sees online. _Fix:_ decide the correct semantics
  (per-room ranking seems more useful and matches capacity accounting) and make
  both views agree, or clearly label them as different numbers.
- **T5 — [High] Room derivation hard-codes age boundaries that are
  admin-editable elsewhere.** [Both] `wlDeriveRoom()`
  (`js/admin/admin-waitlist.js:10-22`) and `PROMOTION_CHAIN` (`:1080-1086`),
  duplicated in `waitlist-status/index.ts:40-46,71-82`, hard-code age cutoffs
  (`months < 12` → bear, etc.) instead of reading the already-admin-editable
  `ROOMS[].ageMinMonths/ageMaxMonths` the way `js/app.js`'s
  `getRoomIdFromDob()` correctly does (with a comment explaining why — Settings
  → Rates lets admins edit these boundaries, and commit `7337a56` actively
  fixed an off-by-one in exactly this data). An admin editing a room's age
  ceiling — a supported, documented action — silently leaves the waitlist
  planner's room routing, priority queue, and graduation forecast on the old
  boundary, in both the admin tool and the parent page equally. _Fix:_ read
  `ROOMS[].ageMinMonths/ageMaxMonths` in both the admin file and the
  edge-function port, mirroring `getRoomIdFromDob()`.

## Medium

- **T6 — [Med] ProCare payment import has no duplicate-protection — silently
  understates AR.** [Admin] `js/admin/admin-billing.js:738-825`
  (`_confirmProCareImport`) upserts invoices (idempotent) but payments are
  plain `INSERT`s via `insertBillingPayment()` with no unique constraint on
  `billing_payments`. A re-uploaded or overlapping ProCare export double-inserts
  payment rows, which *reduces* the computed AR balance
  (`balance = owed - paid`) — a failure mode likely to go unnoticed since it
  looks like good news, and harder to eyeball now that
  `_groupProcareArByFamily()` aggregates per-family. Also `insertImportBatch`'s
  `filename` is hardcoded to `''` at both call sites, discarding the clue that
  would help an admin recognize a re-import. _Fix:_ dedupe on `(family_id,
  payment_date, amount, payment_method)` before insert or add a DB constraint;
  stop hardcoding `filename: ''`.
- **T7 — [Med] Per-day billing preview doesn't exclude weekly-rate days from
  sibling-discount math.** [Public] `js/app.js:1050` calls
  `getChildDayAmounts(dateStr)` without the `excludeStudentIds` argument that
  `buildBillingBreakdown()` correctly uses. The itemized per-date line a parent
  sees can show a different amount/discount than what they're actually billed
  for that date (the grand total is still correct — both derive from
  `buildBillingBreakdown()` — but the line items won't add up if a parent
  checks). A narrower recurrence of the same divergent-code-paths shape that
  caused SS1. _Fix:_ pass the same `excludeStudentIds` (or reuse
  `buildBillingBreakdown`'s `weeklyDatesByChild`) into the line-1050 call.
- **T8 — [Med, policy decision needed] Sibling discount silently dropped when
  both siblings are on the weekly rate.** [Public] Pre-refactor code applied
  the $10 sibling discount even across two children both qualifying for a
  room's weekly rate (`js/app.js:960-1005`,
  `getChildWeeklyWeeks`/`buildBillingBreakdown`); the current refactor prices
  each child's weekly week fully independently. A real, quantifiable pricing
  change (two full-time siblings in a weekly-rate room now cost $10/week more)
  not tracked as a decided policy anywhere. _Fix:_ get business sign-off; if
  unintended, restore the cross-child discount inside the weekly-rate path.
- **T9 — [Med] Auto-merge workflow now blind-`--theirs` on conflicting
  `dist/*.min.js`.** [Both] `.github/workflows/auto-merge-claude.yml`'s
  conflict-auto-resolve allowlist grew to include `dist/admin.min.js`,
  `dist/app.min.js`, `dist/lookup.min.js`; on conflict it now takes one
  branch's pre-built bundle wholesale instead of rebuilding from merged source.
  Per this doc's own stated invariant (the deploy serves committed `dist/`
  verbatim, no server-side build), this can silently regress a just-merged
  feature on the live site until the next branch's build happens to overwrite
  it correctly — the same incident category CLAUDE.md already warns about
  (two `claude/**` branches touching shared files), just for compiled output.
  _Fix:_ on `dist/*` conflict, checkout the source-of-truth branch and re-run
  `npm run build` instead of picking either raw pre-built blob, or drop
  `dist/*` from the auto-resolve allowlist and fail the merge for a human
  rebuild.
- **T10 — [Med] `waitlist-status` has no rate limiting on an exact-email PII
  lookup.** [Public] Confirmed no per-IP/per-email throttle exists. Already
  flagged in `docs/WAITLIST_STATUS.md` and tied to the still-open **S6**
  (PIN-reset throttle). The function's constant-work-regardless-of-match design
  avoids a timing side-channel but doesn't stop unlimited retries. _Fix:_ fold
  into an S6 pass covering both endpoints, per the design doc's own
  recommendation.
- **T11 — [Med] `waitlist-status` duplicates `wlpRunAllocation()` by hand —
  now provably drifting.** [Public] Already flagged as a maintenance risk in
  `docs/WAITLIST_STATUS.md`; T3 above is direct proof the drift has already
  happened. Worth deciding now whether to extract a shared, isomorphic
  allocation module rather than waiting for a third divergence.
- **T12 — [Med] `_buildGraduationIndex` DOB parsing — off-by-one month for
  children born on the 1st.** [Both] `js/admin/admin-waitlist.js:1124` and the
  edge-function port: `new Date(reg.child_dob)` (no `T00:00:00`) parses as UTC
  midnight, which in America/Chicago reads back as the last day of the
  *previous* month whenever DOB's day-of-month is 1, shifting
  graduation/capacity-freeing by one month. The pattern predates this window
  but now drives the new 12-month Capacity Planner grid and the new
  parent-facing forecast. `wlDeriveRoom()` two lines away already has the
  correct pattern (`+ 'T00:00:00'`) to copy.

## Low

- **T13 — [Low]** `${{ github.ref_name }}` interpolated directly into a `run:`
  shell block in `auto-merge-claude.yml` — GitHub Actions script-injection
  anti-pattern, one more instance added this window (pre-existing elsewhere in
  the file). Low practical risk (only trusted sessions push `claude/**`
  branches); switch to an `env:`-passed variable defensively.
- **T14 — [Low]** `send-waitlist-confirmation`'s sequential `applicationId` is
  a mild existence/already-sent enumeration oracle — bounded impact (never
  redirects mail, idempotent, 30-min window). Fold into the S6/T10 rate-limit
  fix rather than treating separately.
- **T15 — [Low]** `send-waitlist-reminders`'s auth check uses substring match
  (`auth.includes(key)`) instead of exact comparison — tighten to
  `auth === \`Bearer ${key}\`` for defense-in-depth; only reachable from
  trusted pg_cron infra today.
- **T16 — [Low]** `offer_type`/`offered_days` (from `waitlist_offer_type.sql`)
  are written (`admin-waitlist.js:1455,1459`) but never read anywhere — confirm
  whether intentionally deferred; if a reader is added later, give it an
  explicit safe default for `NULL` (pre-migration rows), same class as the old
  S3 role-fallback bug.
- **T17 — [Low]** `wlpBaseBooked()` and its edge-function twin don't filter
  `registrations.status = 'cancelled'` — currently dormant (no live admin flow
  sets that status; cancellations hard-delete) but would double-count booked
  seats if a "cancel without delete" flow is ever added.
- **T18 — [Low]** Staff photo filename is built from unsanitized `file.name`
  extension (`admin-settings.js`) — low severity (admin-only upload to their
  own bucket), one-line character whitelist would close it.
- **T19 — [Low]** Two spots in `admin-classrooms.js`'s new roster views render
  `roomLabel` without `escHtml()`, inconsistent with the rest of the same
  functions (S5 convention). Not currently exploitable — room label isn't
  admin-editable — but worth a one-line fix for consistency.
- **T20 — [Low, process]** `js/tests/business-logic.test.js` doesn't exercise
  real `app.js` code — it's a hand-maintained, self-contained reimplementation
  of the *old* single-schedule billing model, never updated for the new
  per-child `buildBillingBreakdown()` architecture. It structurally could not
  have caught SS1 and provides zero coverage of T7/T8 above. Refactor to
  actually `require`/exercise the real functions, or at least add cases for the
  new weekly-rate-exclusion behavior.

## Migration deployment status — ✅ confirmed 2026-07-11, all four applied

Per this repo's own hard-won lesson (`CONTRIBUTING.md` §2), a committed
migration is not a deployed one, and this has broken prod twice already. All
four migrations that this sweep flagged as undocumented —
`add_billing_import_source.sql`, `create_staff_photos_bucket.sql`,
`waitlist_inquiry_tour_reminders.sql`, `waitlist_offer_type.sql` — were
confirmed applied against the live Supabase project on 2026-07-11:
`storage.buckets` has `staff-photos` (`public = true`), and
`information_schema.columns` has all 7 expected columns
(`billing_import_batches.source`; `waitlist_applications.tour_status`/
`tour_scheduled_at`/`tour_completed_at`/`tour_notes`/`offer_type`/
`offered_days`). No action needed on this front.

_Checked and cleared (no bug):_ `confirm-waitlist-interest` is correctly scoped
(unguessable token, CORS-restricted, RLS-blocked from anon reads, no PII
over-return); `send-waitlist-confirmation` never lets the caller redirect mail
to an attacker-chosen address; `send-waitlist-reminders` is service-role-gated
and fails closed on missing settings; `create_staff_photos_bucket.sql`'s public
read / admin-only write split is intentional and appropriate for its stated
purpose (publicly displayed staff headshots); `js/inquiry.js` and
`js/confirm-interest.js` surface real errors on their state-changing actions
(no U6 recurrence); the token-gated confirm/decline flow has no
URL-guessing path to act on another family's offer.
