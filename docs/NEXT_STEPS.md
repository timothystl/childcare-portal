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

## Step 1 — Verify RLS (5 min) — reshapes the security priority
Run STEP 1 of `supabase/migrations/VERIFY_rls_core_tables.sql` in the SQL Editor.
- All `rls_enabled = true` → S1 OK; deprioritize S2.
- Any `false` → TOP priority (anon key can read PII). Do NOT run STEP 2 blindly —
  share the output; we'll write policies that don't break registration/capacity.

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
