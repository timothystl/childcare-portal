# Childcare Portal — Code Review

_Reviewed: 2026-06-04 · App version 1.15.8 · Branch `claude/kind-mendel-I79x6`_

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

### S4 — [Medium] `admin-users` edge function authorization
`supabase/functions/admin-users/index.ts` only rejects when
`roles[callerEmail] !== 'full'` and depends on the `admin_roles` settings row existing.
Confirm: (a) writes to the `settings` table (esp. the `admin_roles` key) are restricted
to the service role via RLS, and (b) the function fails closed when `admin_roles` is
missing rather than treating the caller as privileged.

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

## Suggested remediation order

1. **Confirm RLS** on the four core PII tables (S1) — highest risk, quick to check.
2. **Server-side role enforcement** for admin mutations (S2), plus the role-enum fix
   (S3) and edge-fn fail-closed check (S4).
3. **XSS escaping audit** of `js/admin/*` `.innerHTML` sites (S5).
4. **Quick UX wins:** focus rings (U1), disabled/loading states (U3), silent PIN-reset
   feedback (U6), mobile day-picker (U5).
5. **Design tokens & inline-style cleanup** (V1, V2) — large but mechanical; unblocks
   theming.
6. **Quality/perf refactors** (P1–P2, Q1–Q3) and the `supabase.js` split (M1) as
   ongoing hygiene.

_All findings are recommendations; nothing here was applied to the codebase._
