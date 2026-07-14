# Next Steps — Childcare Portal hardening

Branch: `claude/kind-mendel-I79x6`. Full findings: `docs/CODE_REVIEW.md`
(original S/U/V/N/P/Q/C/M items + second-sweep SS1–SS19 + third-sweep T1–T20,
2026-07-11 + fourth-sweep FS1–FS30, 2026-07-12).

## Incident log — 2026-07-14 — FS1 duplicate-registration cleanup (DONE)

Closing FS1 required reconciling 38 groups of pre-existing duplicate confirmed
`(child_name, month_key)` registrations in prod before
`registrations_child_month_unique` could be created (a partial unique index
can't be added over existing collisions). Worked through with the owner in
four passes, all owner-confirmed before running:

1. **7 safe deletes** — exact duplicates / strict subsets (no unique dates on
   the removed row). Simple `DELETE`.
2. **18 disjoint-date merges** — same child+month split across two rows with
   non-overlapping dates (the FS2 admin "Add New Days" pattern, pre-fix).
   `UPDATE registration_dates SET registration_id = <keep>` then delete the
   emptied row. Room changes mid-month are fine — `registration_dates` carries
   its own `room_id` per date, independent of the parent registration's room.
3. **12 cross-month splits (FS27)** — a second registration's dates spanned
   two calendar months under one `month_key` (the admin-reg calendar-nav bug
   that didn't clear selected days across months, pre-fix). Moved the earlier
   month's day(s) onto the clean registration for that month, then repurposed
   (or merged into an existing) registration for the later month. Also found
   and fixed **4 more standalone cross-month registrations** (Ayla Smith,
   Daphne Marsh, Kezia Gasama, Rory Visintine) that weren't flagged as
   collisions (never duplicated) but had the same underlying date-range bug —
   same split treatment. Daphne Marsh's case included one **owner-confirmed
   dedup of a genuinely double-booked past date** (07-09, booked by both
   parents under separate registrations) — deleted with the owner's OK since
   the date had passed and wouldn't be rebilled.
4. **4 owner-decision cases:**
   - **Patrick Baker (Aug)** — two parents (Megan/Daniel Baker, same phone,
     same DOB, identical 17-date schedule) had each registered him separately.
     Owner confirmed same child; **kept reg 613** (admin-entered, Daniel
     Baker's email), deleted 593.
   - **Josephine & Scarlett Ricketts (Aug)** — same parent (Amy Ricketts),
     disjoint dates split across two admin-entered rows each. Owner confirmed
     **combine**; merged.
   - **Willow French (Jul)** — parent registered her in Goose on Fridays,
     admin later added Summer on Wednesdays — two different rooms, two
     different weekdays, same parent/child. Owner confirmed **this is
     intentional, not a dup** ("fine how it is... director can move her on
     the day if needed"). Since a lasting duplicate would permanently block
     the unique index, merged the two registration rows into **one** (dates
     keep their own per-date `room_id`, so the actual Goose-Fri/Summer-Wed
     schedule is unchanged) — resolves the index conflict without changing
     her care schedule.

Result: 38 → 0 collision groups. `registrations_child_month_unique` created
and verified live via `pg_indexes` (2026-07-14). **Ran without a `NEXT_STEPS.md`
regenerate-invoices reminder being executed by the owner yet** — billing note
below.

**Follow-up still needed:** run admin → Billing → **Generate Invoices** for
May, June, July, and August 2026 — several of the above merges/splits moved
care dates across month boundaries (the FS27 cross-month splits especially),
which changes which month's invoice those days should bill against.

## Backlog — future features (owner ideas, 2026-07-11, not scheduled)

- **Tax reporting statement for parents.** A year-end (or on-demand)
  statement summarizing total childcare expenses paid per family per tax
  year, so parents can claim the dependent-care tax credit / FSA
  reimbursement. Likely a new admin or parent-facing report pulling from
  `billing_summary`/`billing_payments` (see `admin-finance.js`/
  `admin-billing.js` for the existing billing-report patterns to extend).
  Not scoped or estimated yet.
- **Payment processor integration.** Explicitly **deferred to next year or
  later** per the owner — not to be started without a separate go-ahead. Once
  this exists, revisit **T1** (`docs/CODE_REVIEW.md`) as a blocking fix: today
  a client-trusted invoice amount can only produce a wrong-looking email, but
  with real payment processing wired up, the same gap would let a fabricated
  amount actually change what a family gets charged.

## Manual verification checklist — 2026-07-11 session (owner to run)

Everything below was code-fixed and pushed this session (auto-merged to
`main` via `.github/workflows/auto-merge-claude.yml`, which also deploys the
Cloudflare Pages frontend). Edge functions and the Cloudflare Worker are
**not** auto-deployed — those steps are called out explicitly.

### Wave 0 — migrations (already confirmed, no test needed)
- [x] All four migrations confirmed applied via SQL Editor queries — done.

### T3 — `waitlist-status` capacity bug (code fixed + deployed)
- [ ] **Deploy status:** confirmed deployed via the Supabase dashboard.
- [ ] **Functional test:** in the admin dashboard, go to Settings → Capacity,
      change a room's capacity number, save.
- [ ] Open `waitlist-status.html`, look up a real waitlisted child in that
      room by email, confirm their position/wait-estimate reflects the new
      capacity (compare against the admin Waitlist & Capacity Planner's
      number for the same kid — they should tell a consistent story per
      `docs/WAITLIST_STATUS.md`'s own checklist).
- [ ] Revert the capacity change back when done testing.

### T2 — admin message inbox restored (code fixed, frontend auto-deploys)
- [ ] Wait for/confirm the `claude/**` auto-merge finished (check `main`'s
      latest commit, or the site's footer version number — should read the
      version bumped this session).
- [ ] Hard-refresh `admin.html` (cache-bust: `css/admin.css` version bumped
      to `?v=14`, but clear cache if the tab still doesn't appear).
- [ ] Confirm a **Messages** tab now appears in the admin nav (mobile-nav
      drawer, under the "People" group, 💬 icon).
- [ ] Open it — confirm existing messages load (anything sent via Contact Us
      or Waitlist Status → Message the Office since 2026-07-01 should now be
      visible for the first time).
- [ ] Test **Mark as Read** on an unread message — badge count should update.
- [ ] Test **Archive** → then **Show Archived** toggle → confirm it appears in
      the archived list → **Restore** it back.
- [ ] Test **Delete** on a throwaway/test message (confirms the delete
      confirmation dialog and removal).
- [ ] From `calendar.html`, submit a test message via **Contact Us** →
      confirm it shows up in the admin Messages tab.
- [ ] From `waitlist-status.html`, use **Message the Office** → confirm it
      shows up too, prefixed `[Waitlist Status]`.

### T1 — email-wildcard regex gap — ✅ CLOSED (deployed 2026-07-11)
- [x] **Deployed:** owner pasted the updated function into the Supabase
      dashboard and deployed `send-schedule-confirmation`.
- [x] **Worker deploy:** no action needed — `worker.js`'s copy of the fix went
      live automatically via `.github/workflows/auto-merge-claude.yml`'s
      `npx wrangler deploy` step when this session's branch auto-merged.
- [ ] Regression-test the confirmation email on a real registration
      whenever convenient (not urgent — no report of breakage so far).
- **Known residual risk — deliberately NOT fixed, owner-accepted 2026-07-11:**
  this function still has no auth check and trusts client-supplied invoice
  amounts (full write-up: `docs/CODE_REVIEW.md` T1, now filed under Low).
  Owner's call: since there's no payment processor wired up, the worst case
  is a confusing/wrong-looking email, not a real financial loss — not worth
  the risk of destabilizing the confirmation-email path for a fix right now.
  **Revisit as a blocking fix if/when payment processing is added** (see
  Backlog below).

## Third sweep (2026-07-11) — top of the queue

The waitlist/inquiry funnel + admin Waitlist Planner rewrite + Staff Directory +
Finance consolidation (128 commits, v1.15.8 → v1.20.2) was reviewed for the
first time. Full findings: `docs/CODE_REVIEW.md` "Third Sweep" section
(T1–T20). Recommended order:

1. **Migration check — ✅ CONFIRMED 2026-07-11, all four applied.**
   - `create_staff_photos_bucket.sql` — `storage.buckets` shows `staff-photos`
     with `public = true`, matching the migration's intended design.
   - `add_billing_import_source.sql`, `waitlist_inquiry_tour_reminders.sql`,
     `waitlist_offer_type.sql` — `information_schema.columns` confirmed all 7
     expected columns exist (`billing_import_batches.source`;
     `waitlist_applications.tour_status/tour_scheduled_at/tour_completed_at/
     tour_notes/offer_type/offered_days`). No action needed — the frontend
     features that depend on these (ProCare import source tagging, tour
     reminders, waitlist offer-type tracking) are safe in prod.
2. **T3 — ✅ CLOSED (fixed + deployed 2026-07-11).** `waitlist-status` edge fn
   ignored admin capacity overrides (`settings.value` text-vs-object bug) —
   fixed by adding the `parseSettingsValue()` helper already proven in commit
   `6e9977c` to `supabase/functions/waitlist-status/index.ts`; owner deployed
   the update via the Supabase dashboard. Recommended (not yet done): run the
   manual capacity-override check from `docs/WAITLIST_STATUS.md` to confirm
   the live behavior, not just that the deploy succeeded.
3. **T1 — ⚠️ PARTIALLY fixed 2026-07-11.** `send-schedule-confirmation`
   trusted client-supplied invoice amounts with no auth check.
   - ✅ Fixed: the SS13 wildcard gap (email-validation regex now also excludes
     `%`/`_`), same fix mirrored in `worker.js`.
   - ⚠️ NOT fixed: the auth/trust issue itself. The original recommendation
     ("require admin session") was wrong — this function is called by
     anonymous parents right after registering (`js/app.js`'s
     `sendScheduleEmail()`), so gating it behind Supabase Auth would break the
     confirmation email for every parent. The real fix needs the function to
     recompute the billed amount server-side from `registrations`/
     `registration_dates` instead of trusting the request body — deferred
     pending schema verification + staging smoke-test (see `docs/CODE_REVIEW.md`
     T1 for the full explanation). **Needs a deploy** for the regex fix that
     did land (`supabase functions deploy send-schedule-confirmation`), plus
     redeploy the Cloudflare Worker for the `worker.js` fix.
4. **T2 — ✅ code fixed 2026-07-11, needs a deploy + build.** Admin message
   inbox was deleted (commit `89cb987`) but two live features (Contact Us, new
   Waitlist Status "Message the Office") still wrote into the `messages` table
   with nobody able to read it. Restored `js/admin/admin-messages.js`, its
   `js/supabase.js` DB helpers, `admin.html` tab/nav wiring, and its
   `css/admin.css` styling — all byte-identical to the pre-deletion version,
   re-integrated into the current (post-redesign) single-nav admin UI.
   `dist/` rebuilt (`npm run build`). **Needs `git push` + the usual
   claude/** auto-merge/deploy** to go live — see the branch-push step below.
5. **T4, T5** — admin vs. parent "position" semantics disagree (global vs.
   per-room ranking); waitlist room-derivation hard-codes age boundaries that
   are admin-editable via Settings → Rates. Fix together — same two files.
6. **T6, T7, T8** — ProCare duplicate-payment AR understatement; per-day
   billing preview / sibling-discount inconsistencies in the new
   `buildBillingBreakdown()` refactor. Get business sign-off on T8
   specifically (real pricing-policy question) before changing it.
7. **T9** — auto-merge workflow blind-`--theirs`-resolves conflicting
   `dist/*.min.js` bundles instead of rebuilding — fix before two `claude/**`
   branches next land overlapping JS changes.
8. **T13–T20** — low-severity cleanup, opportunistic.
9. Fold **SS13 + S6 + T10 + T14** into one rate-limiting/email-validation pass
   covering PIN-reset, `waitlist-status`, and `send-waitlist-confirmation`
   together, per `docs/WAITLIST_STATUS.md`'s own recommendation.

**Carried-over status:** SS1 (weekly-rate quote/charge divergence) is now
**fixed** — preview and submit both route through the new
`buildBillingBreakdown()`. SS19, SS3, SS9 are **still open, untouched** this
window.

## Incident log — 2026-06-05
- The S1 "tighten anon RLS policies" migration was REVERTED — it broke the parent
  flow and the real exposure needs the RPCs made SECURITY DEFINER first (see below).
  `family_login` IS already SECURITY DEFINER; the registration/dup-check/capacity
  reads are the part that depends on anon SELECT.
- Staff clock-in broke because `hash_staff_pins.sql` had been committed to the repo
  but **never applied to the database**, while the deployed frontend already used
  the hashed-PIN RPC. Resolved by applying the migration (columns added split, PINs
  hashed from the old plaintext `staff_pin`, RPCs created, schema cache reloaded).
- LESSON: before deploying the branch, confirm every migration the frontend depends
  on is actually applied in Supabase (the dashboard is the source of truth, not the
  repo's `migrations/` folder). Check `pg_proc` / `information_schema.columns` first.

## Ready-to-apply work (written 2026-06-05 pm)

### A. Finish deploying what's fixed — YOU run these (I have no CLI/creds)
- `supabase functions deploy send-waitlist-offer`     # SS4 (auth)
- `supabase functions deploy send-schedule-confirmation`  # SS13 (email validation)
- Deploy the Cloudflare Worker (SS13 fix in `worker.js`)
- Apply migration `supabase/migrations/harden_definer_search_path.sql` (SS10)

### B. SS12 — one open clock-in per staff/day  (low risk)
- Apply `supabase/migrations/ss12_one_open_clock_event.sql` (check for existing
  duplicate open shifts first — query is in the file header).

### C. SS2 — family leading-zero PIN fix  ✅ DONE (2026-06-05)
Migration `ss2_family_login_text_pin.sql` applied; `family-lookup` edge fn
redeployed; `js/supabase.js` `familyLogin` shipped. Leading-zero PINs verified
working on both the parent portal and the registration-page lookup.

### D. SS1 — close the anon-read PII exposure  (groundwork done; staged)
1. Apply `supabase/migrations/ss1_public_read_rpcs.sql` (creates capacity_counts
   + registration_conflict definer RPCs; safe, no behavior change).
2. Switch the frontend reads to those RPCs, deploy, test registration + calendar.
3. THEN drop the wide-open anon policies (DROP statements are listed in the
   migration's footer). Test login + kiosk + registration in staging first.

### E. Branch/deploy hygiene
- See `CONTRIBUTING.md` (rebase on main before merge; apply migrations before
  deploying dependent code). This is what caused today's two incidents.

## Step 0 — Ship what's already fixed (~15 min)
Already committed; just deploy:
1. Merge/deploy the branch → Cloudflare Pages auto-builds the frontend
   (U7 + admin fixes SS6/SS7/SS14/SS15 go live).
2. Redeploy edge functions (SS4 auth + SS13 injection fixes):
   - `supabase functions deploy send-waitlist-offer`
   - `supabase functions deploy send-schedule-confirmation`
3. Redeploy the Cloudflare Worker (SS13 fix in `worker.js`).
4. Apply migration `supabase/migrations/harden_definer_search_path.sql` (SS10) in the
   Supabase SQL Editor — safe, non-invasive (`ALTER FUNCTION` only).

## Step 1 — RLS policy review — ⚠️ HIGH ISSUE FOUND (now top priority)
RLS is enabled, BUT the policy conditions (checked 2026-06-05) are wide open:
anon `USING (true)` SELECT/UPDATE on families, SELECT/UPDATE/DELETE on students,
public SELECT on staff (exposes salaries), and anon SELECT on registrations/
registration_dates. The anon key is public (in the browser bundle), so anyone can
dump parent/child PII + staff pay and tamper with/delete records.

Code-verified that families/students/staff anon policies are vestigial (no public
page uses those tables directly — parent flows use service-role edge fns + definer
RPCs). FIX:
- **NOW (safe):** apply `supabase/migrations/tighten_anon_rls_policies.sql`
  (drops the vestigial families/students/staff anon policies). Then test in staging:
  parent registration + calendar spots-left, clock-in kiosk, admin Families/Staff tabs.
- **Tier 2:** registrations/registration_dates anon SELECT is load-bearing (dup-check +
  capacity) — fold those reads into SECURITY DEFINER RPCs, then drop the anon SELECT.
  Do this with the registration RPC (SS3/SS5/SS9).

S2 (server-side admin roles) remains relevant but lower than this.

## Step 2 — Quick high-value fixes
1. **SS2** — leading-zero PIN lockout. Make PINs text end-to-end
   (`family_login`/`lookup_staff_by_pin` + drop `parseInt`). Test one login in staging.
2. **SS1** — weekly-rate overcharge. Only urgent if enabling weekly rates. Fix = share the
   weekly-rate calc between preview and submit; verify quote == receipt == invoice.
3. **SS5/SS3/SS9** — one atomic registration RPC (server-side capacity + amount +
   transaction). DECISION NEEDED: where do room capacities live server-side
   (a `room_capacities` table, or hardcoded in the RPC)?

## Step 3 — Remaining hardening (needs DB/staging testing)
SS11 (staff PIN throttle), SS12 (clock-in partial unique index), SS16 (login-attempt
decay), SS17 (clock-out date/RLS), SS18 (token cleanup / pg_cron), S2 (server-side admin
roles), S4 (edge-fn fail-closed), S6 (PIN-reset throttle), S7 (trim family_login RPC).

## Step 4 — Quality (needs a browser)
U3 (disable-on-submit), U4 (responsive), V2–V6 (design tokens / inline styles), P1–P3
(calendar/billing perf), M1 (split js/supabase.js).

## To unblock the assistant
- Paste the S1 STEP-1 query output (or give a staging URL) → unblocks SS2 + auth work.
- Decide the capacity source (table vs hardcode) → unblocks the registration RPC.

## Pending review — Waitlist Status page (shipped 2026-07-10, v1.20.1)
Not yet code-reviewed. Full architecture, security model, and manual test
checklist: **`docs/WAITLIST_STATUS.md`**. Short version of what to look at:
- The edge function (`supabase/functions/waitlist-status/index.ts`) duplicates
  the admin planner's allocation algorithm (`wlpRunAllocation()` in
  `admin-waitlist.js`) rather than sharing it — flag whether that's an
  acceptable maintenance burden.
- No rate limiting on the lookup — same open gap as S6 (PIN-reset throttle),
  now on two unauthenticated email-lookup endpoints instead of one.
- Cross-check position/estimated-wait against the admin Waitlist & Capacity
  Planner for a few real kids before signing off — the two views must agree.
