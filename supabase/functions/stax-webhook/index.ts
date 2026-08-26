// ============================================================
// stax-webhook — records refunds/voids Stax reports after the fact
// ============================================================
// Scaffolding, not yet live-tested — see the ⚠️ block below.
//
// charge-stax-payment records a successful charge synchronously (Stax's
// /charge call returns success/failure directly, unlike Authorize.net's
// redirect+webhook flow). What still needs a webhook is anything that
// happens LATER and outside this app entirely — a refund or void issued
// from the Stax dashboard, a dispute/chargeback — the same "processor's
// own report is authoritative, not the browser" instinct as
// authorizenet-webhook, just covering a narrower slice of events since the
// charge itself doesn't need it here.
//
//   1. Every request must carry the shared-secret header before anything
//      in the payload is trusted (see the ⚠️ note below — this is a
//      placeholder until Stax's actual signature scheme is confirmed).
//   2. Idempotent by construction — billing_payments_processor_txn_idx
//      (processor, processor_transaction_id) is a unique index, so a
//      retried webhook cannot double-record the same event, matching
//      authorizenet-webhook.
//   3. A refund/void is recorded as its OWN negative billing_payments row
//      (refund_of_payment_id pointing at the original charge), never by
//      editing the original — same rule as authorizenet-webhook.
//   4. Only an event tied to a transaction id this app actually recorded
//      (processor='stax') is acted on — a refund for a transaction we
//      have no record of is logged and ignored rather than guessed at.
//
// ⚠️ UNCONFIRMED — Stax sandbox merchant not yet activated (2026-08-26),
//   see create-stax-charge's header. Two things in this file are written
//   from general Stax API-reference reading, not a working webhook
//   delivery, and MUST be confirmed before this is registered with Stax
//   or deployed to production:
//     - The signature/auth scheme Stax actually uses for webhook delivery
//       (header name, HMAC algorithm, what it's computed over). This file
//       currently checks a shared secret in a custom header
//       (X-Stax-Webhook-Secret) as a conservative fail-closed placeholder
//       — replace with real signature verification once confirmed, the
//       same way AUTHORIZENET_SIGNATURE_KEY / X-ANET-Signature works in
//       authorizenet-webhook.
//     - The event payload shape for refund/void events (event type
//       strings, where the original vs. reversal transaction id lives).
//
// Deploy:  supabase functions deploy stax-webhook --no-verify-jwt
//          (called by Stax, not a signed-in user)
// Secrets: STAX_WEBHOOK_SECRET (placeholder — see ⚠️ above)
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(body: unknown, status: number) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

serve(async (req) => {
    // Acknowledge reachability checks the same way authorizenet-webhook
    // does — a GET/HEAD ping before registration must not 404/500.
    if (req.method === "GET" || req.method === "HEAD") return json({ ok: true }, 200);
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const secret = Deno.env.get("STAX_WEBHOOK_SECRET");
    if (!secret) return json({ received: true, ignored: "webhook not configured yet" }, 200);

    // ⚠️ Placeholder auth — see header. Confirm Stax's real scheme before
    // registering this URL with Stax.
    if (req.headers.get("X-Stax-Webhook-Secret") !== secret) {
        return json({ error: "Unauthorized" }, 401);
    }

    let event: any;
    try { event = await req.json(); } catch { return json({ error: "Bad payload" }, 400); }

    // ⚠️ Event type / field names unconfirmed — adjust once a real
    // delivery can be inspected. Stax's docs (as of the getting-started
    // guide) mention event types like update_transaction_settled;
    // refund/void event naming was not confirmed this session.
    const eventType: string = event?.type || event?.event || "";
    const isRefundOrVoid = /refund|void/i.test(eventType);
    if (!isRefundOrVoid) return json({ received: true, ignored: eventType || "unknown" }, 200);

    const originalTransactionId = String(event?.data?.parent_id || event?.data?.transaction_id || "");
    const reversalTransactionId = String(event?.data?.id || "");
    const amount = Number(event?.data?.total || event?.data?.total_refunded || 0);
    if (!originalTransactionId || !reversalTransactionId || !amount) {
        return json({ received: true, ignored: "incomplete event payload" }, 200);
    }

    const admin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: original } = await admin
        .from("billing_payments")
        .select("id, family_id, invoice_id")
        .eq("processor", "stax")
        .eq("processor_transaction_id", originalTransactionId)
        .maybeSingle();
    if (!original) return json({ received: true, ignored: "unknown original transaction" }, 200);

    const { error: insErr } = await admin.from("billing_payments").insert({
        family_id: original.family_id,
        invoice_id: original.invoice_id,
        amount: -Math.abs(amount),
        payment_date: new Date().toISOString().slice(0, 10),
        payment_method: "card",
        note: `Stax ${eventType} of payment #${original.id}`,
        created_by: "stax-webhook",
        processor: "stax",
        processor_transaction_id: reversalTransactionId,
        refund_of_payment_id: original.id,
    });
    if (insErr && String(insErr.code) !== "23505" && !/duplicate key/i.test(insErr.message || "")) {
        return json({ error: insErr.message }, 500);
    }

    if (original.invoice_id) {
        const { data: paymentRows } = await admin
            .from("billing_payments").select("amount").eq("invoice_id", original.invoice_id);
        const totalPaid = (paymentRows || []).reduce((s: number, p: { amount: number }) => s + (Number(p.amount) || 0), 0);
        const { data: invoiceRow } = await admin
            .from("billing_invoices").select("final_amount").eq("id", original.invoice_id).maybeSingle();
        const finalAmount = Number(invoiceRow?.final_amount) || 0;
        const newStatus = totalPaid >= finalAmount && finalAmount > 0 ? "paid" : (totalPaid > 0 ? "partial" : "sent");
        await admin.from("billing_invoices").update({ status: newStatus }).eq("id", original.invoice_id);
    }

    return json({ received: true }, 200);
});
