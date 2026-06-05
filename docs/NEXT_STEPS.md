# Next Steps — Childcare Portal hardening

Branch: `claude/kind-mendel-I79x6`. Full findings: `docs/CODE_REVIEW.md`
(original S/U/V/N/P/Q/C/M items + second-sweep SS1–SS19).

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
