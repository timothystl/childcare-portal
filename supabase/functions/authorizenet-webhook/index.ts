// ============================================================
// authorizenet-webhook — the only thing that marks an invoice paid,
// refunded, or voided online
// ============================================================
// create-payment-session hands the family off to Authorize.net's hosted
// page and never hears back directly — the browser return URL is purely
// cosmetic (a parent can close the tab, lose signal, or the redirect can
// fail, and none of that should change what's owed). admin-refund-payment
// is the same story from the office side: it only asks Authorize.net to
// reverse a charge, it never touches billing_payments itself. This
// function is the one authoritative record for all three: Authorize.net
// calls it server-to-server once something actually happens, we re-fetch
// that transaction from Authorize.net's own API (never trust the webhook
// body), and only then do we write to billing_payments.
//
//   1. Every request is signature-verified (HMAC-SHA512 over the raw body,
//      keyed by AUTHORIZENET_SIGNATURE_KEY) before anything in it is read.
//      An unsigned or mis-signed request is rejected outright. GET/HEAD and
//      an unsigned POST before the key exists both return a bare 200 —
//      Authorize.net's own Merchant Interface pings the URL to confirm it's
//      reachable BEFORE the webhook is saved and a key is even issued, and
//      a 401/405/500 there reads as "invalid endpoint" and blocks creation.
//   2. The webhook payload is treated as a pointer, not a source of truth:
//      it tells us a transaction id exists; getTransactionDetailsRequest
//      (called with our own merchant credentials) is what actually supplies
//      the amount, the invoiceNumber (for a charge) or the original
//      transaction it reverses (for a refund/void).
//   3. Idempotent by construction — billing_payments_processor_txn_idx
//      (processor, processor_transaction_id) is a unique index, so a
//      webhook retry (Authorize.net resends on anything but 200) cannot
//      double-record the same event. A duplicate is treated as success.
//   4. A refund or void is recorded as its OWN negative billing_payments
//      row (refund_of_payment_id pointing at the original), never by
//      editing or deleting the original charge — same "append a
//      corrective record" instinct as the rest of this app's billing
//      history. Only an approved event (responseCode 1) is ever recorded.
//
// Deploy:  supabase functions deploy authorizenet-webhook --no-verify-jwt
//          (this endpoint is called by Authorize.net, not a signed-in user —
//          it authenticates via the HMAC signature instead of a JWT)
// Secrets: AUTHORIZENET_API_LOGIN_ID, AUTHORIZENET_TRANSACTION_KEY,
//          AUTHORIZENET_SIGNATURE_KEY, AUTHORIZENET_ENVIRONMENT
//
// Register this function's URL in the Authorize.net Merchant Interface
// (Account → Settings → Webhooks) for net.authorize.payment.authcapture
// .created, net.authorize.payment.refund.created and
// net.authorize.payment.void.created, and copy the Signature Key it shows
// you into the AUTHORIZENET_SIGNATURE_KEY secret.
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

async function anetTransactionDetails(apiUrl: string, loginId: string, transactionKey: string, transId: string): Promise<any> {
    const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            getTransactionDetailsRequest: {
                merchantAuthentication: { name: loginId, transactionKey },
                transId,
            },
        }),
    });
    const rawText = (await res.text()).replace(/^﻿/, "");
    return JSON.parse(rawText);
}

/** Insert one billing_payments row (idempotent on processor+transaction id) and reconcile the invoice. */
async function recordAndReconcile(admin: any, row: {
    family_id: string; invoice_id: number; amount: number; note: string;
    processor_transaction_id: string; refund_of_payment_id?: number | null;
}): Promise<{ recorded: boolean; duplicate?: boolean }> {
    const { error: insErr } = await admin.from("billing_payments").insert({
        family_id:                 row.family_id,
        invoice_id:                row.invoice_id,
        amount:                    row.amount,
        payment_date:              new Date().toISOString().slice(0, 10),
        payment_method:            "card",
        note:                      row.note,
        created_by:                "authorizenet-webhook",
        processor:                 "authorizenet",
        processor_transaction_id:  row.processor_transaction_id,
        refund_of_payment_id:      row.refund_of_payment_id ?? null,
    });
    if (insErr) {
        if (String(insErr.code) === "23505" || /duplicate key/i.test(insErr.message || "")) {
            return { recorded: false, duplicate: true };
        }
        throw new Error(insErr.message);
    }

    const { data: paymentRows } = await admin
        .from("billing_payments").select("amount").eq("invoice_id", row.invoice_id);
    const totalPaid = (paymentRows || []).reduce((s: number, p: { amount: number }) => s + (Number(p.amount) || 0), 0);
    const { data: invoiceRow } = await admin
        .from("billing_invoices").select("final_amount").eq("id", row.invoice_id).maybeSingle();
    const finalAmount = Number(invoiceRow?.final_amount) || 0;
    const newStatus = totalPaid >= finalAmount && finalAmount > 0 ? "paid" : (totalPaid > 0 ? "partial" : "sent");
    await admin.from("billing_invoices").update({ status: newStatus }).eq("id", row.invoice_id);

    return { recorded: true };
}

serve(async (req) => {
    // Authorize.net's own Merchant Interface pings the URL (GET/HEAD, no
    // signature) to confirm it's reachable BEFORE the webhook is saved and a
    // signature key is even issued — a 405/500 here reads as "invalid
    // endpoint" and blocks creation. A bare 200 costs nothing: nothing
    // downstream of this line is reachable without a valid POST + signature.
    if (req.method === "GET" || req.method === "HEAD") return json({ ok: true }, 200);
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const rawBody = await req.text();
    const signatureKey = Deno.env.get("AUTHORIZENET_SIGNATURE_KEY");
    // Same reachability-check problem can arrive as a POST with no/blank
    // signature before the key exists. Acknowledge rather than 500, so
    // webhook creation isn't blocked on a secret that can only be set AFTER
    // creation returns it. Once the secret is set, an unsigned POST still
    // never reaches the signature check below — this only fires pre-setup.
    if (!signatureKey) return json({ received: true, ignored: "webhook not configured yet" }, 200);

    const sigHeader = req.headers.get("X-ANET-Signature");
    const ok = await verifySignature(rawBody, sigHeader, signatureKey).catch(() => false);
    if (!ok) return json({ error: "Bad signature" }, 401);

    let event: any;
    try { event = JSON.parse(rawBody); } catch { return json({ error: "Bad payload" }, 400); }

    const eventType: string = event?.eventType || "";
    const isCharge = eventType === "net.authorize.payment.authcapture.created";
    const isRefund = eventType === "net.authorize.payment.refund.created";
    const isVoid   = eventType === "net.authorize.payment.void.created";
    if (!isCharge && !isRefund && !isVoid) {
        return json({ received: true, ignored: eventType || "unknown" }, 200);
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
    // and, for a charge, which invoice it was for. ──────────────────────
    let detail: any;
    try {
        detail = await anetTransactionDetails(apiUrl, loginId, transactionKey, String(transId));
    } catch { return json({ error: "Could not read transaction details" }, 502); }

    const tx = detail?.transaction;
    if (!tx || detail?.messages?.resultCode !== "Ok") {
        return json({ received: true, ignored: "transaction lookup failed" }, 200);
    }
    // responseCode: 1 = approved. Anything else (declined, error) should
    // not be recorded.
    if (String(tx.responseCode) !== "1") {
        return json({ received: true, ignored: "transaction not approved" }, 200);
    }

    const admin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (isCharge) {
        const invoiceNumber: string = tx?.order?.invoiceNumber || "";
        const m = /^mdoinv-(\d+)$/.exec(invoiceNumber);
        if (!m) return json({ received: true, ignored: "no matching invoice reference" }, 200);
        const invoiceId = Number(m[1]);
        const amount = Number(tx.authAmount ?? tx.settleAmount ?? 0);
        if (!Number.isFinite(amount) || amount <= 0) {
            return json({ received: true, ignored: "zero or invalid amount" }, 200);
        }

        const { data: invoice, error: invErr } = await admin
            .from("billing_invoices").select("id, family_id").eq("id", invoiceId).maybeSingle();
        if (invErr) return json({ error: invErr.message }, 500);
        if (!invoice) return json({ received: true, ignored: "invoice not found" }, 200);

        const result = await recordAndReconcile(admin, {
            family_id: invoice.family_id, invoice_id: invoice.id, amount,
            note: "Paid online via Authorize.net",
            processor_transaction_id: String(transId),
        }).catch((e: Error) => ({ error: e.message } as any));
        if (result?.error) return json({ error: result.error }, 500);

        await admin.from("admin_audit_log").insert({
            admin_email: "authorizenet-webhook", action: "online_payment", entity: "billing_invoice",
            details: { invoice_id: invoice.id, amount, processor_transaction_id: String(transId) },
        }).then(() => {}, (e: unknown) => console.error("authorizenet-webhook: audit write failed", e));

        return json({ received: true, ...result, invoiceId: invoice.id, amount }, 200);
    }

    // ── Refund or void: find the original charge this reverses ─────────
    // ⚠️ Verified live against the sandbox, and the two are NOT symmetric:
    //   - A refund gets its own new transaction id; getTransactionDetailsRequest
    //     on it returns refTransId/refTransID pointing at the original.
    //   - A void does NOT create a new transaction — Authorize.net returns the
    //     SAME transId as the charge it voids (confirmed: voiding transaction
    //     80058619513 returned transId 80058619513, not a new one), and
    //     getTransactionDetailsRequest on it carries NO refTransId/refTransID
    //     field at all (present only in the direct createTransactionRequest
    //     response, not in the details lookup). So for a void, the event's
    //     own transId already IS the original's id — there is no separate
    //     reference field to read.
    const refTransId: string = isVoid ? String(transId) : (tx?.refTransId || tx?.refTransID || "");
    if (!refTransId) return json({ received: true, ignored: "no original transaction reference" }, 200);

    const { data: original, error: origErr } = await admin
        .from("billing_payments")
        .select("id, family_id, invoice_id, amount")
        .eq("processor", "authorizenet")
        .eq("processor_transaction_id", refTransId)
        .maybeSingle();
    if (origErr) return json({ error: origErr.message }, 500);
    if (!original) return json({ received: true, ignored: "original payment not found" }, 200);

    // A void carries the original auth amount in its own transaction detail;
    // fall back to the original payment's recorded amount if that's absent
    // (a full reversal either way — this app only ever submits full
    // refunds/voids, see admin-refund-payment).
    const reverseAmount = Number(tx.authAmount ?? tx.settleAmount ?? original.amount) || Number(original.amount) || 0;
    if (!(reverseAmount > 0)) return json({ received: true, ignored: "zero or invalid reversal amount" }, 200);

    // A refund's transId is genuinely new and unique on its own. A void's
    // transId is the ORIGINAL charge's id (see the note above) — storing it
    // as-is would collide with the original payment's own row on the
    // (processor, processor_transaction_id) unique index and be silently
    // treated as an already-recorded duplicate, so the void would never
    // actually get recorded. The ":void" suffix keeps it unique.
    const reversalTransactionId = isVoid ? `${transId}:void` : String(transId);

    const result = await recordAndReconcile(admin, {
        family_id: original.family_id, invoice_id: original.invoice_id, amount: -reverseAmount,
        note: isRefund ? "Refund via Authorize.net" : "Void via Authorize.net",
        processor_transaction_id: reversalTransactionId,
        refund_of_payment_id: original.id,
    }).catch((e: Error) => ({ error: e.message } as any));
    if (result?.error) return json({ error: result.error }, 500);

    await admin.from("admin_audit_log").insert({
        admin_email: "authorizenet-webhook",
        action:      isRefund ? "online_refund" : "online_void",
        entity:      "billing_invoice",
        details:     { invoice_id: original.invoice_id, payment_id: original.id, amount: -reverseAmount, processor_transaction_id: reversalTransactionId },
    }).then(() => {}, (e: unknown) => console.error("authorizenet-webhook: audit write failed", e));

    return json({ received: true, ...result, invoiceId: original.invoice_id, amount: -reverseAmount }, 200);
});
