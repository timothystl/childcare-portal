// ============================================================
// reconcile-stax-payments — safety net for a missed Stax webhook
// ============================================================
// Mirrors reconcile-anet-payments' reasoning: stax-webhook is the only
// thing that's supposed to confirm an ambiguous/pending charge, but webhook
// delivery is never guaranteed (Stax's own docs offer no retry guarantee,
// and this app's own stax-webhook header already documents that Stax does
// not sign its webhooks at all). Without this job, a missed delivery left
// a `payment_charge_locks` row stuck 'pending'/'ambiguous' forever — the
// family-wide unique index (payment_charge_locks_active_family_idx) then
// blocks that family from paying online again until a human intervenes,
// per the external security review that flagged this gap (2026-08-28).
//
// ⚠️ UNVERIFIED AGAINST A LIVE MERCHANT — read before enabling the cron.
// Stax's `GET /transaction` list/filter endpoint is documented
// (list-and-filter-all-transactions) to accept customer_id/type/startDate/
// endDate, but this repo has no production Stax merchant to smoke-test it
// against (see CLAUDE.md's Stax section — sandbox only as of this writing),
// and the CSP work earlier in this file's history is a standing reminder
// that a vendored API's real behavior can diverge from its docs. So this
// function is written defensively:
//   * The list endpoint is used ONLY for discovery (candidate transaction
//     ids). Nothing from it is ever trusted for a decision.
//   * Every candidate is re-fetched through GET /transaction/{id} — the
//     SAME single-transaction call stax-webhook already verifies live
//     production data through — and only that response's own `meta`/
//     `success` fields decide anything.
//   * If the list endpoint's filters don't work as documented, the worst
//     case is zero candidates found and nothing happens — the existing gap
//     persists, but nothing is corrupted. stax_set_charge_state() itself
//     refuses to downgrade a lock already recorded 'processor_succeeded'
//     (see harden_stax_payments.sql), so even a wrong match here can never
//     erase a real success.
// Confirm the audit_log rows this job writes show a nonzero `candidates`
// count against a real stuck lock before trusting it to run unattended.
//
//   1. A lock is "stale" once STALE_MINUTES have passed with no webhook —
//      long enough that this never races the synchronous charge call that
//      created the lock (which itself waits on Stax's response before the
//      client sees anything).
//   2. A stale lock with a matching, successful Stax transaction is
//      recovered through the exact same stax_set_charge_state +
//      stax_finalize_charge pair charge-stax-payment and stax-webhook both
//      already use — this file duplicates no billing logic of its own.
//   3. A stale lock with a matching but unsuccessful transaction, or with
//      NO matching transaction after RELEASE_HOURS, is marked 'failed' —
//      which is not in payment_charge_locks_active_family_idx's blocking
//      set, so the family can simply try again. A family whose charge
//      truly never reached Stax (a network failure before Stax received
//      the request) must not be locked out indefinitely by this job's own
//      caution.
//
// Deploy:   supabase functions deploy reconcile-stax-payments
// Schedule: schedule_stax_reconciliation.sql (pg_cron + pg_net, mirrors
//           schedule_anet_reconciliation.sql's pattern)
// Secrets:  STAX_API_KEY, RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_REPLY_TO
//           (all already set for the other Stax/email functions)
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STAX_API_URL = "https://apiprod.fattlabs.com";
const STALE_MINUTES = 15;
const RELEASE_HOURS = 2;

function json(body: unknown, status: number) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function escHtml(s: unknown): string {
    return String(s ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function staxGet(apiKey: string, path: string): Promise<any> {
    const res = await fetch(`${STAX_API_URL}${path}`, {
        headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, body };
}

/** Discovery only — never trusted for a decision, see the header note. */
async function listCandidateTransactionIds(apiKey: string, customerId: string, sinceIso: string): Promise<string[]> {
    const qs = new URLSearchParams({
        customer_id: customerId, type: "charge",
        startDate: sinceIso, endDate: new Date().toISOString(),
    });
    const { ok, body } = await staxGet(apiKey, `/transaction?${qs.toString()}`);
    if (!ok) return [];
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    return rows.map((r: any) => String(r?.id || "")).filter(Boolean);
}

/** The one call whose response this job actually trusts, same as stax-webhook. */
async function verifyTransaction(apiKey: string, id: string): Promise<any | null> {
    const { ok, body } = await staxGet(apiKey, `/transaction/${encodeURIComponent(id)}`);
    if (!ok) return null;
    const t = body?.data && typeof body.data === "object" ? body.data : body;
    return t?.id ? t : null;
}

function attemptIdOf(t: any): string {
    return String(t?.idempotency_id || t?.meta?.payment_attempt_id || t?.meta?.paymentAttemptId || "").toLowerCase();
}

async function sendAlertEmail(o: {
    repaired: Array<{ lockId: number; transactionId: string; amount: number }>;
    released: Array<{ lockId: number; reason: string }>;
}): Promise<void> {
    const apiKey = Deno.env.get("RESEND_API_KEY");
    const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev";
    const toEmail = Deno.env.get("RESEND_REPLY_TO") || "mdo@timothystl.org";
    if (!apiKey) { console.warn("reconcile-stax-payments: RESEND_API_KEY not set, skipping alert"); return; }

    const rows = [
        ...o.repaired.map(r => `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;">lock ${r.lockId}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">$${escHtml(r.amount.toFixed(2))}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#2f7d4f;">Recorded (${escHtml(r.transactionId)})</td></tr>`),
        ...o.released.map(r => `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;">lock ${r.lockId}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">—</td><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#B3261E;">Released — ${escHtml(r.reason)}</td></tr>`),
    ].join("");

    const html = `<!DOCTYPE html><html><body style="font-family:Georgia,serif;background:#f4f4f4;margin:0;padding:32px 16px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
  <tr><td style="background:#01294A;padding:22px 32px;"><h1 style="margin:0;color:#fff;font-size:18px;">Stax payment reconciliation</h1></td></tr>
  <tr><td style="padding:24px 32px;">
    <p style="margin:0 0 14px;color:#333;font-size:14px;line-height:1.6;">
      A stuck Stax payment attempt was found without a completed webhook.
      ${o.repaired.length ? `${o.repaired.length} charge${o.repaired.length === 1 ? "" : "s"} recorded directly.` : ""}
      ${o.released.length ? `${o.released.length} attempt${o.released.length === 1 ? "" : "s"} released so the family can try again.` : ""}
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border:1px solid #eee;border-radius:8px;overflow:hidden;">
      <tr style="background:#f8fafc;"><td style="padding:8px 12px;font-weight:700;">Attempt</td><td style="padding:8px 12px;font-weight:700;">Amount</td><td style="padding:8px 12px;font-weight:700;">Result</td></tr>
      ${rows}
    </table>
    <p style="margin:16px 0 0;color:#888;font-size:12px;">Automated message from the MDO Stax reconciliation job. Check Invoices → Accounts Receivable for the full picture.</p>
  </td></tr>
</table></body></html>`;

    try {
        await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                from: fromEmail, to: [toEmail],
                subject: `Stax reconciliation: ${o.repaired.length} recorded, ${o.released.length} released`,
                html,
            }),
        });
    } catch (e) {
        console.error("reconcile-stax-payments: alert email failed", e);
    }
}

serve(async (_req) => {
    try {
        const apiKey = Deno.env.get("STAX_API_KEY");
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        if (!apiKey) return json({ error: "Stax is not configured" }, 500);
        const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

        const staleBefore = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();
        const releaseBeforeMs = Date.now() - RELEASE_HOURS * 3600 * 1000;
        const { data: stale, error: staleErr } = await admin
            .from("payment_charge_locks")
            .select("id, family_id, idempotency_key, charge_amount, created_at, updated_at")
            .eq("processor", "stax")
            .in("status", ["pending", "ambiguous"])
            .lt("updated_at", staleBefore);
        if (staleErr) return json({ error: "Could not load pending Stax attempts" }, 500);

        const repaired: Array<{ lockId: number; transactionId: string; amount: number }> = [];
        const released: Array<{ lockId: number; reason: string }> = [];

        for (const lock of stale || []) {
            const { data: family } = await admin.from("families")
                .select("stax_customer_id").eq("id", lock.family_id).maybeSingle();
            const customerId = family?.stax_customer_id;
            if (!customerId) continue; // nothing to look up against; leave for a human

            const sinceIso = new Date(new Date(lock.created_at).getTime() - 3600 * 1000).toISOString();
            const candidateIds = await listCandidateTransactionIds(apiKey, customerId, sinceIso);

            let matched: any = null;
            for (const id of candidateIds) {
                const t = await verifyTransaction(apiKey, id);
                if (t && attemptIdOf(t) === lock.idempotency_key) { matched = t; break; }
            }

            if (matched) {
                const success = matched.success === true
                    && (!matched.status || String(matched.status).toUpperCase() === "SUCCESS");
                if (success) {
                    const { error: stateErr } = await admin.rpc("stax_set_charge_state", {
                        p_lock_id: lock.id, p_status: "processor_succeeded",
                        p_transaction_id: String(matched.id),
                        p_note: "Recovered by scheduled reconciliation (no webhook delivery seen)",
                    });
                    if (!stateErr) {
                        const { data: finalized, error: finalizeErr } = await admin.rpc("stax_finalize_charge", { p_lock_id: lock.id });
                        if (!finalizeErr) {
                            repaired.push({ lockId: lock.id, transactionId: String(matched.id), amount: Number(finalized?.amount) || Number(lock.charge_amount) || 0 });
                        }
                    }
                } else {
                    await admin.rpc("stax_set_charge_state", {
                        p_lock_id: lock.id, p_status: "failed", p_transaction_id: String(matched.id),
                        p_note: "Reconciliation found a non-successful Stax transaction for this attempt",
                    });
                    released.push({ lockId: lock.id, reason: "Stax shows this attempt failed" });
                }
                continue;
            }

            if (new Date(lock.updated_at).getTime() < releaseBeforeMs) {
                await admin.rpc("stax_set_charge_state", {
                    p_lock_id: lock.id, p_status: "failed",
                    p_note: `No matching Stax transaction found after ${RELEASE_HOURS}h; released for retry`,
                });
                released.push({ lockId: lock.id, reason: `no matching transaction after ${RELEASE_HOURS}h` });
            }
            // Otherwise: still within the grace window, leave for the next run.
        }

        await admin.from("admin_audit_log").insert({
            admin_email: "reconcile-stax-payments", action: "payment_reconciliation", entity: "billing_invoice",
            details: {
                candidates: (stale || []).length, repaired: repaired.length, released: released.length,
                repaired_locks: repaired.map(r => r.lockId), released_locks: released.map(r => r.lockId),
            },
        }).then(() => {}, (e: unknown) => console.error("reconcile-stax-payments: audit write failed", e));

        if (repaired.length > 0 || released.length > 0) {
            await sendAlertEmail({ repaired, released });
        }

        return json({ candidates: (stale || []).length, repaired: repaired.length, released: released.length }, 200);
    } catch (err) {
        return json({ error: (err as Error).message }, 500);
    }
});
