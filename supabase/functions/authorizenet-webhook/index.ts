// ============================================================
// authorizenet-webhook — the only thing that marks an invoice paid online
// ============================================================
// create-payment-session hands the family off to Authorize.net's hosted
// page and never hears back directly — the browser return URL is purely
// cosmetic (a parent can close the tab, lose signal, or the redirect can
// fail, and none of that should change what's owed). This function is the
// authoritative record: Authorize.net calls it server-to-server once a
// transaction settles, we re-fetch that transaction from Authorize.net's
// own API (never trust the amount in the webhook body), and only then do
// we write to billing_payments.
//
//   1. Every request is signature-verified (HMAC-SHA512 over the raw body,
//      keyed by AUTHORIZENET_SIGNATURE_KEY) before anything in it is read.
//      An unsigned or mis-signed request is rejected outright.
//   2. The webhook payload is treated as a pointer, not a source of truth:
//      it tells us a transaction id exists; getTransactionDetailsRequest
//      (called with our own merchant credentials) is what actually supplies
//      the amount and the invoiceNumber we set in create-payment-session.
//   3. Idempotent by construction — billing_payments_processor_txn_idx
//      (processor, processor_transaction_id) is a unique index, so a
//      webhook retry (Authorize.net resends on anything but 200) cannot
//      double-record the same charge. A duplicate is treated as success.
//   4. Only a settled, approved transaction (authCaptureTransaction /
//      priorAuthCaptureTransaction, responseCode 1) is recorded. A decline
//      or a void is acknowledged (200, so Authorize.net stops retrying) but
//      writes nothing.
//
// Deploy:  supabase functions deploy authorizenet-webhook --no-verify-jwt
//          (this endpoint is called by Authorize.net, not a signed-in user —
//          it authenticates via the HMAC signature instead of a JWT)
// Secrets: AUTHORIZENET_API_LOGIN_ID, AUTHORIZENET_TRANSACTION_KEY,
//          AUTHORIZENET_SIGNATURE_KEY, AUTHORIZENET_ENVIRONMENT
//
// After deploying, register this function's URL in the Authorize.net
// Merchant Interface (Account → Settings → Webhooks) for the
// net.authorize.payment.authcapture.created event, and copy the Signature
// Key it shows you into the AUTHORIZENET_SIGNATURE_KEY secret.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANET_API_URL = {
    sandbox:    "https://apitest.authorize.net/xml/v1/request.api",
    production: "https://api.authorize.net/xml/v1/request.api",
};

function json(body: unknown, status: number) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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

async function verifySignature(rawBody: string, headerSig: string | null, signatureKeyHex: string): Promise<boolean> {
    if (!headerSig) return false;
    const provided = headerSig.replace(/^sha512=/i, "").trim().toUpperCase();
    const key = await crypto.subtle.importKey(
        "raw", hexToBytes(signatureKeyHex), { name: "HMAC", hash: "SHA-512" }, false, ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    const computed = bytesToHex(mac);
    // Constant-time-ish compare; both are fixed-length hex strings.
    if (computed.length !== provided.length) return false;
    let diff = 0;
    for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ provided.charCodeAt(i);
    return diff === 0;
}

serve(async (req) => {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const rawBody = await req.text();
    const signatureKey = Deno.env.get("AUTHORIZENET_SIGNATURE_KEY");
    if (!signatureKey) return json({ error: "Webhook not configured" }, 500);

    const sigHeader = req.headers.get("X-ANET-Signature");
    const ok = await verifySignature(rawBody, sigHeader, signatureKey).catch(() => false);
    if (!ok) return json({ error: "Bad signature" }, 401);

    let event: any;
    try { event = JSON.parse(rawBody); } catch { return json({ error: "Bad payload" }, 400); }

    // Only care about a capture actually landing. Refunds/voids/declines
    // are acknowledged (200) so Authorize.net stops retrying, but recorded
    // nowhere — this app has no online-refund flow yet.
    if (event?.eventType !== "net.authorize.payment.authcapture.created") {
        return json({ received: true, ignored: event?.eventType || "unknown" }, 200);
    }

    const transId = event?.payload?.id;
    if (!transId) return json({ received: true, ignored: "no transaction id" }, 200);

    const env = (Deno.env.get("AUTHORIZENET_ENVIRONMENT") || "sandbox").toLowerCase();
    const apiUrl = ANET_API_URL[env as "sandbox" | "production"] || ANET_API_URL.sandbox;
    const loginId = Deno.env.get("AUTHORIZENET_API_LOGIN_ID");
    const transactionKey = Deno.env.get("AUTHORIZENET_TRANSACTION_KEY");
    if (!loginId || !transactionKey) return json({ error: "Payment processing is not configured" }, 500);

    // ── Re-fetch the transaction from Authorize.net itself. The webhook
    // body is just a pointer; this call is the source of truth for amount
    // and which invoice it was for. ─────────────────────────────────────
    const detailRes = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            getTransactionDetailsRequest: {
                merchantAuthentication: { name: loginId, transactionKey },
                transId: String(transId),
            },
        }),
    });
    const detailText = (await detailRes.text()).replace(/^﻿/, "");
    let detail: any;
    try { detail = JSON.parse(detailText); } catch { return json({ error: "Could not read transaction details" }, 502); }

    const tx = detail?.transaction;
    if (!tx || detail?.messages?.resultCode !== "Ok") {
        return json({ received: true, ignored: "transaction lookup failed" }, 200);
    }
    // responseCode: 1 = approved. Anything else settled as a decline/error
    // and should not be recorded as a payment.
    if (String(tx.responseCode) !== "1") {
        return json({ received: true, ignored: "transaction not approved" }, 200);
    }

    const invoiceNumber: string = tx?.order?.invoiceNumber || "";
    const m = /^mdoinv-(\d+)$/.exec(invoiceNumber);
    if (!m) return json({ received: true, ignored: "no matching invoice reference" }, 200);
    const invoiceId = Number(m[1]);
    const amount = Number(tx.authAmount ?? tx.settleAmount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
        return json({ received: true, ignored: "zero or invalid amount" }, 200);
    }

    const admin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: invoice, error: invErr } = await admin
        .from("billing_invoices")
        .select("id, family_id, final_amount")
        .eq("id", invoiceId)
        .maybeSingle();
    if (invErr) return json({ error: invErr.message }, 500);
    if (!invoice) return json({ received: true, ignored: "invoice not found" }, 200);

    // Idempotent insert — a resend of the same event hits the unique index
    // on (processor, processor_transaction_id) and is treated as success,
    // not double-recorded.
    const { error: insErr } = await admin.from("billing_payments").insert({
        family_id:                invoice.family_id,
        invoice_id:                invoice.id,
        amount,
        payment_date:              new Date().toISOString().slice(0, 10),
        payment_method:            "card",
        note:                      "Paid online via Authorize.net",
        created_by:                "authorizenet-webhook",
        processor:                 "authorizenet",
        processor_transaction_id:  String(transId),
    });
    if (insErr) {
        // Unique-violation on the idempotency index means this transaction
        // was already recorded by an earlier delivery of the same event —
        // not an error worth retrying over.
        if (String(insErr.code) === "23505" || /duplicate key/i.test(insErr.message || "")) {
            return json({ received: true, duplicate: true }, 200);
        }
        return json({ error: insErr.message }, 500);
    }

    // Reconcile the invoice's status against everything paid so far.
    const { data: paymentRows } = await admin
        .from("billing_payments").select("amount").eq("invoice_id", invoice.id);
    const totalPaid = (paymentRows || []).reduce((s: number, p: { amount: number }) => s + (Number(p.amount) || 0), 0);
    const finalAmount = Number(invoice.final_amount) || 0;
    const newStatus = totalPaid >= finalAmount ? "paid" : (totalPaid > 0 ? "partial" : "sent");
    await admin.from("billing_invoices").update({ status: newStatus }).eq("id", invoice.id);

    await admin.from("admin_audit_log").insert({
        admin_email: "authorizenet-webhook",
        action:      "online_payment",
        entity:      "billing_invoice",
        details:     { invoice_id: invoice.id, amount, processor_transaction_id: String(transId) },
    }).then(() => {}, (e: unknown) => console.error("authorizenet-webhook: audit write failed", e));

    return json({ received: true, recorded: true, invoiceId: invoice.id, amount }, 200);
});
