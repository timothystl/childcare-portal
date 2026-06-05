# Next Steps — Childcare Portal hardening

Branch: `claude/kind-mendel-I79x6`. Full findings: `docs/CODE_REVIEW.md`
(original S/U/V/N/P/Q/C/M items + second-sweep SS1–SS19).

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

### C. SS2 — family leading-zero PIN fix  (SEQUENCED — order matters)
1. Apply `supabase/migrations/ss2_family_login_text_pin.sql` (staging → prod).
2. `supabase functions deploy family-lookup` after editing it to NOT `parseInt`
   the PIN (send the string). Edit `supabase/functions/family-lookup/index.ts:48`:
   replace `const parsedPin = parseInt(pin, 10)` + the int send with a digit check
   and pass the string to `family_login`.
3. Frontend: `js/supabase.js` `familyLogin()` — replace `parseInt(pin,10)` /
   `p_pin: parsedPin` with a `/^\d{4,8}$/` check and `p_pin: String(pin).trim()`.
   (Ping the assistant to push this once steps 1–2 are live — pushing it before
   the migration can break login, since a string to the old INT function is
   rejected.)

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
