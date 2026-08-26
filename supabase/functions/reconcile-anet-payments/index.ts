// ============================================================
// reconcile-anet-payments — daily safety net for missed Authorize.net
// webhooks
// ============================================================
// authorizenet-webhook is the only thing that's supposed to mark an invoice
// paid — Authorize.net calls it the moment a charge succeeds. But webhook
// delivery is not guaranteed. Found live 2026-08-26: a real, approved
// sandbox charge (Visa test card, transId 80058622754, invoiceNumber
// mdoinv-3847) was never delivered to us at all — even though the webhook
// endpoint was registered correctly, active, and subscribed to the right
// three events. The gap was entirely on Authorize.net's delivery side, not
// a config mistake here, and it was silent: the family's app kept showing
// the invoice as owed even though they had already paid, and nothing else
// in the system had any way to notice.
//
// This function runs daily (pg_cron, see schedule_anet_reconciliation.sql)
// and closes that gap. It asks Authorize.net directly for every
// transaction it has on record for the last few days, and for any approved
// charge against one of OUR invoices (invoiceNumber matching mdoinv-<id>)
// that ISN'T already in billing_payments, it replays that transaction
// through authorizenet-webhook itself — the exact same signed-event shape
// Authorize.net would have sent, so it goes through the exact same
// idempotent insert, invoice reconcile, and receipt-email logic. Nothing
// here duplicates that logic; this just makes sure the real event
// eventually arrives one way or another.
//
//   1. Two sources, because a charge moves between them: unsettled (same
//      day, still capturedPendingSettlement) and settled (already through
//      the nightly batch). A 3-day settlement window means a single missed
//      run can't create a permanent gap — the next run still sees it.
//   2. Scoped to CHARGES only (authcapture) for now — the high-volume case,
//      and the one this was built to catch. A voided/refunded transaction
//      found in the sweep is counted and reported, never auto-repaired:
//      reversals are comparatively rare (per the office's own "rarely
//      though"), and a voided transaction's list entry carries the SAME
//      transId as the original charge — telling "charge never recorded"
//      apart from "charge recorded, reversal never recorded" needs a
//      second lookup this function doesn't do yet. A human should look
//      before anything writes a reversal to billing_payments.
//   3. Every run writes an admin_audit_log row, even a clean one — "ran,
//      found nothing" is itself worth a durable record, the same instinct
//      as the rest of this app's audit trail. An email to the office only
//      fires when something was actually repaired or a replay failed; a
//      clean night should not generate mail.
//
// Deploy:   supabase functions deploy reconcile-anet-payments
// Schedule: schedule_anet_reconciliation.sql (pg_cron + pg_net, mirrors
//           schedule_day_summary_APPLIED.sql's pattern)
// Secrets:  same AUTHORIZENET_* + RESEND_* as authorizenet-webhook —
//           nothing new to configure.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANET_API_URL = {
    sandbox:    "https://apitest.authorize.net/xml/v1/request.api",
    production: "https://api.authorize.net/xml/v1/request.api",
};

// A charge that has completed but not yet run through the nightly batch,
// or has. Either way, it happened and should be recorded.
const CHARGE_STATUSES = new Set(["capturedPendingSettlement", "settledSuccessfully"]);
// Best-effort only — used for the informational count in behavior #2's
// report, never to decide what gets written. Not exhaustively verified
// against Authorize.net's full transactionStatus enum.
const REVERSAL_STATUSES = new Set(["voided", "refundSettledSuccessfully", "refundPendingSettlement"]);

function json(body: unknown, status: number) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function anetPost(env: string, body: unknown): Promise<any> {
    const apiUrl = ANET_API_URL[env as "sandbox" | "production"] || ANET_API_URL.sandbox;
    const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const rawText = (await res.text()).replace(/^﻿/, "");
    try { return JSON.parse(rawText); } catch { return null; }
}

function hexToBytes(hex: string): Uint8Array {
    const clean = hex.trim().replace(/^0x/i, "");
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}
function bytesToHex(buf: ArrayBuffer): string {
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}
/** Same HMAC-SHA512-over-raw-body scheme authorizenet-webhook itself verifies. */
async function signBody(rawBody: string, signatureKeyHex: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        "raw", hexToBytes(signatureKeyHex), { name: "HMAC", hash: "SHA-512" }, false, ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    return bytesToHex(mac);
}

function escHtml(s: unknown): string {
    return String(s ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function sendAlertEmail(o: {
    repaired: Array<{ transId: string; invoiceNumber: string; amount: number }>;
    failed: Array<{ transId: string; status?: number; error?: string }>;
    reversalsSeenCount: number;
}): Promise<void> {
    const apiKey = Deno.env.get("RESEND_API_KEY");
    const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev";
    // Same office inbox already used for the geofence and waitlist alerts
    // (settings.geofence.notify_email / settings.waitlist_notify) — no new
    // address to configure.
    const toEmail = Deno.env.get("RESEND_REPLY_TO") || "mdo@timothystl.org";
    if (!apiKey) { console.warn("reconcile-anet-payments: RESEND_API_KEY not set, skipping alert"); return; }

    const rows = [
        ...o.repaired.map(r => `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;">${escHtml(r.invoiceNumber)}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">$${escHtml(r.amount)}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#2f7d4f;">Recorded</td></tr>`),
        ...o.failed.map(f => `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;">transId ${escHtml(f.transId)}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">—</td><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#B3261E;">Replay failed — needs a look</td></tr>`),
    ].join("");

    const html = `<!DOCTYPE html><html><body style="font-family:Georgia,serif;background:#f4f4f4;margin:0;padding:32px 16px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
  <tr><td style="background:#01294A;padding:22px 32px;"><h1 style="margin:0;color:#fff;font-size:18px;">Online payment reconciliation</h1></td></tr>
  <tr><td style="padding:24px 32px;">
    <p style="margin:0 0 14px;color:#333;font-size:14px;line-height:1.6;">
      Today's sweep found ${o.repaired.length} approved Authorize.net charge${o.repaired.length === 1 ? "" : "s"} that never came through as a webhook, and recorded ${o.repaired.length === 1 ? "it" : "them"} directly.
      ${o.failed.length ? `${o.failed.length} more could not be replayed automatically and need a manual look.` : ""}
      ${o.reversalsSeenCount ? `${o.reversalsSeenCount} void/refund-status transaction${o.reversalsSeenCount === 1 ? "" : "s"} were also seen in this sweep — those are not auto-reconciled; check the AR tool if one looks like it's missing its reversal.` : ""}
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border:1px solid #eee;border-radius:8px;overflow:hidden;">
      <tr style="background:#f8fafc;"><td style="padding:8px 12px;font-weight:700;">Invoice / reference</td><td style="padding:8px 12px;font-weight:700;">Amount</td><td style="padding:8px 12px;font-weight:700;">Result</td></tr>
      ${rows}
    </table>
    <p style="margin:16px 0 0;color:#888;font-size:12px;">Automated message from the MDO payment reconciliation job. Check Invoices → Accounts Receivable for the full picture.</p>
  </td></tr>
</table></body></html>`;

    try {
        await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                from: fromEmail, to: [toEmail],
                subject: o.failed.length
                    ? `⚠️ Payment reconciliation: ${o.repaired.length} recorded, ${o.failed.length} need a look`
                    : `Payment reconciliation: ${o.repaired.length} payment${o.repaired.length === 1 ? "" : "s"} recorded`,
                html,
            }),
        });
    } catch (e) {
        console.error("reconcile-anet-payments: alert email failed", e);
    }
}

serve(async (_req) => {
    try {
        const env = (Deno.env.get("AUTHORIZENET_ENVIRONMENT") || "sandbox").toLowerCase();
        const loginId = Deno.env.get("AUTHORIZENET_API_LOGIN_ID");
        const transactionKey = Deno.env.get("AUTHORIZENET_TRANSACTION_KEY");
        const signatureKey = Deno.env.get("AUTHORIZENET_SIGNATURE_KEY");
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        if (!loginId || !transactionKey || !signatureKey) {
            return json({ error: "Payment processing is not fully configured" }, 500);
        }
        const merchantAuthentication = { name: loginId, transactionKey };

        // ── 1. Gather candidate transactions from both windows ──────
        const rows: any[] = [];

        const unsettled = await anetPost(env, { getUnsettledTransactionListRequest: { merchantAuthentication } });
        if (unsettled?.messages?.resultCode === "Ok") rows.push(...(unsettled.transactions || []));

        const now = new Date();
        const past = new Date(now.getTime() - 3 * 24 * 3600 * 1000);
        const batchesRes = await anetPost(env, {
            getSettledBatchListRequest: {
                merchantAuthentication, includeStatistics: false,
                firstSettlementDate: past.toISOString(), lastSettlementDate: now.toISOString(),
            },
        });
        const batchIds: string[] = (batchesRes?.batchList || []).map((b: any) => b.batchId).filter(Boolean);
        for (const batchId of batchIds) {
            const txRes = await anetPost(env, { getTransactionListRequest: { merchantAuthentication, batchId } });
            if (txRes?.messages?.resultCode === "Ok") rows.push(...(txRes.transactions || []));
        }

        // Dedupe by transId — the same charge can appear in both an
        // unsettled scan today and a settled-batch scan tomorrow.
        const byId = new Map<string, any>();
        for (const r of rows) if (r?.transId) byId.set(String(r.transId), r);

        const candidates = [...byId.values()].filter(r => /^mdoinv-\d+$/.test(String(r.invoiceNumber || "")));
        const charges = candidates.filter(r => CHARGE_STATUSES.has(r.transactionStatus));
        const reversalsSeenCount = candidates.filter(r => REVERSAL_STATUSES.has(r.transactionStatus)).length;

        // ── 2. Which charges are already recorded? ───────────────────
        const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        const transIds = charges.map(c => String(c.transId));
        const { data: existingRows } = transIds.length
            ? await admin.from("billing_payments").select("processor_transaction_id")
                .eq("processor", "authorizenet").in("processor_transaction_id", transIds)
            : { data: [] as any[] };
        const already = new Set((existingRows || []).map((r: any) => r.processor_transaction_id));
        const missing = charges.filter(c => !already.has(String(c.transId)));

        // ── 3. Replay each missing charge through the real webhook ───
        const repaired: Array<{ transId: string; invoiceNumber: string; amount: number }> = [];
        const failed: Array<{ transId: string; status?: number; error?: string }> = [];
        for (const c of missing) {
            const eventBody = JSON.stringify({
                notificationId: `reconcile-${c.transId}`,
                eventType: "net.authorize.payment.authcapture.created",
                eventDate: new Date().toISOString(),
                payload: { responseCode: 1, id: String(c.transId) },
            });
            const sig = await signBody(eventBody, signatureKey);
            try {
                const res = await fetch(`${supabaseUrl}/functions/v1/authorizenet-webhook`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "X-ANET-Signature": `sha512=${sig}` },
                    body: eventBody,
                });
                const out = await res.json().catch(() => ({} as any));
                if (res.ok && out?.recorded) {
                    repaired.push({ transId: String(c.transId), invoiceNumber: c.invoiceNumber, amount: Number(c.settleAmount) || 0 });
                } else if (!res.ok) {
                    failed.push({ transId: String(c.transId), status: res.status });
                }
                // A `received:true, ignored:...` 200 (e.g. invoice not found) is
                // left uncounted on purpose — Authorize.net's own retry-on-
                // non-200 behavior wouldn't have fixed that either.
            } catch (e) {
                failed.push({ transId: String(c.transId), error: String(e) });
            }
        }

        // ── 4. Always log the run; only email when something happened ──
        await admin.from("admin_audit_log").insert({
            admin_email: "reconcile-anet-payments", action: "payment_reconciliation", entity: "billing_invoice",
            details: {
                scanned: candidates.length, charges_scanned: charges.length,
                repaired: repaired.length, failed: failed.length,
                reversals_seen: reversalsSeenCount,
                repaired_transids: repaired.map(r => r.transId),
            },
        }).then(() => {}, (e: unknown) => console.error("reconcile-anet-payments: audit write failed", e));

        if (repaired.length > 0 || failed.length > 0) {
            await sendAlertEmail({ repaired, failed, reversalsSeenCount });
        }

        return json({
            scanned: candidates.length, charges_scanned: charges.length,
            repaired: repaired.length, failed: failed.length, reversals_seen: reversalsSeenCount,
            details: { repaired, failed },
        }, 200);
    } catch (err) {
        return json({ error: (err as Error).message }, 500);
    }
});
