# Waitlist Status page — feature notes for code review

_Shipped: 2026-07-10 · App version v1.20.1 · PR #78 (merged to `main`)_

Self-serve page for parents to check their child's enrollment-waitlist position
without logging in. Recreates the `design_handoff_parent_waitlist_status/`
design handoff. Companion to the admin **Waitlist & Capacity Planner**
(`admin.html` → Waitlist tab).

Not yet reviewed — this doc is the on-ramp for that review, plus the manual
test checklist that should be run (against the live site) before/during it.

---

## What it does (parent-facing)

`waitlist-status.html` — a single card, no login/PIN. Parent types the email
they applied with, clicks **Check Status**, and sees one of three states:

1. **Empty** — nothing looked up yet.
2. **Not found** — generic "we couldn't find that email" message (deliberately
   uninformative — see Security below) + a **Message the Office** button.
3. **Found** — child's name, room, a status pill (**Next in line!** / **Almost
   there!** / **Waiting**), position (`#2 of 6`) with a progress bar, an
   estimated wait **range** (never an exact date — e.g. "1 – 2 months"), a
   sibling-priority callout (only shown when it applies), a read-only summary
   of what they requested (desired start / days / full-or-half), and the same
   Message the Office button.

**Message the Office** opens an inline textarea; Send reuses the existing
Contact-Us pipeline (`addMessage()` → `messages` table — the same table/flow
that powers the floating Contact Us button on `calendar.html`), with the
message body prefixed `[Waitlist Status]` so office staff can tell where it
came from without a second inbox.

Linked from: `index.html`'s waitlist FAQ answer, and `inquiry.html`'s
post-submit success screen ("check your waitlist status anytime...").

## How it works (architecture)

```
waitlist-status.html          → page shell (css/styles.css + css/waitlist-status.css)
js/waitlist-status.js         → vanilla-JS state machine (empty/notfound/found), DOM updates
js/supabase.js                → lookupWaitlistStatus(email) — the one new client-side call
supabase/functions/
  waitlist-status/index.ts    → the actual lookup + math (new edge function, service-role key)
```

The page never queries `waitlist_applications` directly. It POSTs `{ email }`
to the `waitlist-status` edge function, which:

1. Fetches **all** `waitlist_applications`, **all** `registrations` (with
   `registration_dates`), and the `settings.room_capacity` override — same
   inputs the admin planner uses.
2. Runs `runAllocation()` — a **line-by-line TypeScript port** of
   `js/admin/admin-waitlist.js`'s `wlpRunAllocation()` and its helpers
   (`wlDeriveRoom`, `wlpAppDays`, `wlpDesiredMonthIdx`, `wlpSortByPriority`,
   `wlpMonths`, `wlpBaseBooked`, `_buildGraduationIndex` → `wlpGradEvents`,
   `wlpComputeGradGrid`). This is intentional duplication, not
   drift — **if the admin planner's algorithm changes, this file needs the
   same change or the two views will disagree.** There is no shared module
   between the browser bundle and the Deno edge function, so nothing enforces
   this automatically. Flag this coupling in review — worth deciding whether
   it's acceptable long-term or worth extracting to a shared, isomorphic file.
3. Finds the row matching the submitted email (case-insensitive, active
   statuses only: `pending`/`offered`/`accepted`), looks up its position in
   its **room's** priority queue (siblings first, then longest-waiting), and
   converts its allocated "fit month" into a soft range string.
4. Returns only the minimal fields the card needs — never the full roster.

## Security model (this is the part most worth scrutinizing)

The design handoff explicitly calls out that an email-only, no-PIN lookup
must not become an email-enumeration oracle. Mitigations in place:

- **No direct table access.** `waitlist_applications` RLS already blocks
  anon `SELECT` entirely (`"Auth all"` policy, authenticated-only) — the
  edge function uses the **service-role** key to bypass RLS, same pattern as
  the existing `family-lookup` function.
- **Identical work for found vs. not-found.** The function always runs the
  full fetch + allocation pipeline regardless of whether the email matches
  anything, and only branches into `{found:false}` vs. `{found:true, ...}`
  at the very end. This means a "no such email" response costs the same
  DB round-trips/compute as a real one — nothing for a timing side-channel
  to key off.
- **CORS locked to prod origin** (`https://mdo.timothystl.org`), matching
  `family-lookup`.
- **Known gap — no rate limiting.** There is currently no per-IP throttle on
  this endpoint. This is a **pre-existing gap shared with the PIN-reset flow**
  (tracked as S6 in `docs/CODE_REVIEW.md` / `docs/NEXT_STEPS.md`), not
  something new this feature introduced — but this endpoint has the same
  enumeration-via-brute-force exposure and should probably be fixed
  alongside S6 rather than separately. **Recommend prioritizing S6 to cover
  both endpoints in one pass.**

## Files touched (for the diff walkthrough)

| File | What changed |
|---|---|
| `waitlist-status.html` | new page |
| `css/waitlist-status.css` | new page-specific styles (tokens/components reused from `css/styles.css`) |
| `js/waitlist-status.js` | new page logic |
| `js/supabase.js` | + `lookupWaitlistStatus(email)` (edge-fn caller, mirrors `lookupFamilyForRegistration`) |
| `supabase/functions/waitlist-status/index.ts` | new edge function (see Architecture above) |
| `index.html` | 1-line FAQ answer edit, adds a link |
| `inquiry.html` | 1-line success-screen edit, adds a link |
| `scripts/build.js` | registers the new page's bundle + HTML patch entry |
| `dist/waitlist-status.min.js`, `dist/supabase.min.js`, `dist/admin.min.js` | rebuilt bundles |

No DB migrations. No RLS changes. No new tables/columns.

## Manual test checklist (run before/during the review)

### Functional (live site)
- [ ] Look up a real applicant's email → get a result card, not "not found"
- [ ] Look up an email not on the waitlist → clean "We couldn't find that
      email" state
- [ ] Look up a family with `has_sibling = true` → amber sibling-priority
      callout appears
- [ ] Look up a family with `has_sibling = false` → callout fully absent
      (not just empty/hidden — the design spec says no alternate message
      either)
- [ ] Look up the #1 position in a room's queue → pill reads **"Next in
      line!"** (green)
- [ ] Look up someone in the back half of a room's queue → pill reads
      **"Waiting"** (amber)

### Cross-check against the admin planner (the core correctness requirement)
- [ ] Pick 2–3 kids currently on the waitlist. For each, compare
      `waitlist-status.html`'s position + estimated wait against what the
      admin **Waitlist & Capacity Planner** shows for the same kid. They
      must tell a consistent story — e.g. if the planner says a kid fits in
      September and the parent page says "5–6 months" when September is 2
      months out, that's a real bug (see the duplication risk in
      Architecture above).

### Message the Office
- [ ] Submit a test message → confirm it lands in the same place existing
      Contact-Us messages go, tagged `[Waitlist Status]`

### Discoverability
- [ ] `index.html` waitlist FAQ link → lands on `waitlist-status.html`
- [ ] `inquiry.html` success-screen link → same

### Device check
- [ ] Phone-width screen — single 440px-max card, should hold up, but worth
      eyeballing

## Review focus areas (where to spend scrutiny time)

1. **The duplicated allocation algorithm** (Architecture, point 2) — is
   TS-porting `wlpRunAllocation()` into the edge function an acceptable
   maintenance burden, or should this be refactored into one shared,
   isomorphic module both the browser bundle and the Deno function import?
2. **Rate limiting** — same open gap as S6, arguably higher priority now
   that there are two unauthenticated lookup-by-email endpoints instead of
   one.
3. **`messages` table** — still has no tracked migration in
   `supabase/migrations/` (pre-existing gap, not introduced by this
   feature, but this PR adds a second caller of `addMessage()`). Worth
   deciding whether to finally write a `CREATE TABLE IF NOT EXISTS`
   migration for it while it's in view.
