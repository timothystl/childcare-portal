// ============================================================
// stax-webhook — records refunds/voids Stax reports after the fact
// ============================================================
// charge-stax-payment records a successful charge synchronously (Stax's
// /charge call returns success/failure directly, unlike Authorize.net's
// redirect+webhook flow). What still needs a webhook is anything that
// happens LATER and outside this app entirely — a refund or void issued
// from the Stax dashboard, a dispute/chargeback — the same "processor's
// own report is authoritative, not the browser" instinct as
// authorizenet-webhook, just covering a narrower slice of events since the
// charge itself doesn't need it here.
//
// ⚠️ VERIFIED LIVE 2026-08-27 against a real registered webhook and real
// sandbox refunds — this is the third revision, and this one is confirmed
// by an actual delivery, not just doc-reading:
//   - Registered for update_transaction first (per Stax's docs on how a
//     refund is described): NEVER fired, for a charge, a refund, or a
//     second refund, across the whole test.
//   - Registered for create_transaction: fired within ~1 second for a
//     fresh charge, AND fired again for a refund of that same charge.
//     CONCLUSION: a refund/void delivers as its own create_transaction
//     event — Stax treats the reversal as a new transaction being
//     created, not the parent being updated. The POSTed body is that
//     transaction directly (not nested under a parent's
//     child_transactions[] the way the refund/void ENDPOINT RESPONSE
//     shape had suggested) — this function now reads `type` and
//     `reference_id` off the top-level body.
//   - This function is registered for create_transaction only; a
//     create_transaction event for an ordinary charge (type: "charge") is
//     ignored here, since charge-stax-payment already recorded it
//     synchronously — only type "refund"/"void" is acted on.
//
//   1. STAX HAS NO HMAC SIGNATURE SCHEME AT ALL (confirmed against the
//      webhook resource's own schema and its creation endpoint — neither
//      has a secret/signing field). The actual model: you embed a secret
//      of your own choosing as a query param on the target_url you
//      register, and Stax POSTs to that literal URL verbatim.
//   2. Idempotent by construction — billing_payments_processor_txn_idx
//      (processor, processor_transaction_id) is a unique index, so a
//      retried webhook cannot double-record the same event, matching
//      authorizenet-webhook.
//   3. ⚠️ May reverse SEVERAL billing_payments rows per Stax transaction
//      (2026-08-27) — charge-stax-payment's allocateAcrossDueSet can split
//      one real Stax charge across multiple invoices (a family's own
//      rollup), suffixing each row's processor_transaction_id with
//      "-inv<invoiceId>". A refund/void event names the ORIGINAL charge's
//      bare id via reference_id, so this looks up every row matching that
//      bare id OR any "<id>-inv*" suffix (findOriginalPaymentRows, same
//      helper shape as authorizenet-webhook's) and allocates the
//      refund/void total across them oldest-invoice-first, capped per row.
//   4. A refund/void is recorded as its OWN negative billing_payments row
//      per original row it reverses (refund_of_payment_id pointing at that
//      row), never by editing the original — same rule as
//      authorizenet-webhook.
//   5. Only an event tied to a transaction id this app actually recorded
//      (processor='stax') is acted on — a refund for a transaction we have
//      no record of is logged and ignored rather than guessed at.
//
// Deploy:  supabase functions deploy stax-webhook --no-verify-jwt
//          (called by Stax, not a signed-in user — auth is the URL secret)
// Secrets: STAX_WEBHOOK_SECRET (the value embedded in the registered
//          target_url's ?secret= query param)
// Register with Stax's Core API: POST /webhook
//          { "target_url": "<this function's URL>?secret=<STAX_WEBHOOK_SECRET>",
//            "event": "create_transaction" }
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(body: unknown, status: number) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type PaymentRow = { id: number; invoice_id: number; family_id: string; amount: number };

/** Same shape as authorizenet-webhook's copy — see its header for why this has to match by prefix, not exact id. */
async function findOriginalPaymentRows(admin: any, baseTransactionId: string): Promise<PaymentRow[]> {
    const { data } = await admin
        .from("billing_payments")
        .select("id, invoice_id, family_id, amount, billing_invoices(billing_cycles(month))")
        .eq("processor", "stax")
        .or(`processor_transaction_id.eq.${baseTransactionId},processor_transaction_id.like.${baseTransactionId}-inv%`);
    const rows = (data || []) as any[];
    rows.sort((a, b) => {
        const ma = a?.billing_invoices?.billing_cycles?.month || "";
        const mb = b?.billing_invoices?.billing_cycles?.month || "";
        return ma.localeCompare(mb);
    });
    return rows.map(r => ({ id: r.id, invoice_id: r.invoice_id, family_id: r.family_id, amount: Number(r.amount) || 0 }));
}

serve(async (req) => {
    // Acknowledge reachability checks — a GET/HEAD ping before registration
    // must not 404/500.
    if (req.method === "GET" || req.method === "HEAD") return json({ ok: true }, 200);
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const secret = Deno.env.get("STAX_WEBHOOK_SECRET");
    if (!secret) return json({ received: true, ignored: "webhook not configured yet" }, 200);

    // Stax has no signature scheme (see header). The registered target_url
    // itself carries the secret as a query param; this compares it to what
    // was actually registered with Stax.
    const url = new URL(req.url);
    if (url.searchParams.get("secret") !== secret) return json({ error: "Unauthorized" }, 401);

    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Bad payload" }, 400); }

    // The POST body is the transaction object itself — verified live: a
    // refund/void delivers as its own create_transaction event, and the
    // body IS that reversal transaction (top-level type/reference_id/total),
    // not nested under a parent's child_transactions[].
    const kind = String(body?.type || "").toLowerCase();
    if (kind !== "refund" && kind !== "void") {
        // Ordinary charges also arrive here (this function is registered
        // for create_transaction) — charge-stax-payment already recorded
        // those synchronously, so there is nothing to do for them.
        return json({ received: true, ignored: kind || "not a reversal" }, 200);
    }

    const childId = String(body?.id || "");
    const parentId = String(body?.reference_id || "");
    const total = Math.round((Number(body?.total) || 0) * 100) / 100;
    if (!childId || !parentId || total <= 0.004) {
        return json({ received: true, ignored: "incomplete reversal payload" }, 200);
    }

    const admin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const originalRows = await findOriginalPaymentRows(admin, parentId);
    if (!originalRows.length) return json({ received: true, ignored: "unknown original transaction" }, 200);

    let anyNew = false;
    let remaining = total;
    const touchedInvoiceIds: number[] = [];

    for (const row of originalRows) {
        if (remaining <= 0.004) break;
        const amt = Math.round(Math.min(remaining, row.amount) * 100) / 100;
        if (amt <= 0.004) continue;

        const { error: insErr } = await admin.from("billing_payments").insert({
            family_id: row.family_id,
            invoice_id: row.invoice_id,
            amount: -amt,
            payment_date: new Date().toISOString().slice(0, 10),
            payment_method: "card",
            note: `Stax ${kind} of payment #${row.id}`,
            created_by: "stax-webhook",
            processor: "stax",
            processor_transaction_id: `${childId}-row${row.id}`,
            refund_of_payment_id: row.id,
        });
        const isDuplicate = insErr && (String(insErr.code) === "23505" || /duplicate key/i.test(insErr.message || ""));
        if (insErr && !isDuplicate) return json({ error: insErr.message }, 500);
        if (!isDuplicate) anyNew = true;
        touchedInvoiceIds.push(row.invoice_id);
        remaining = Math.round((remaining - amt) * 100) / 100;

        const { data: paymentRows } = await admin
            .from("billing_payments").select("amount").eq("invoice_id", row.invoice_id);
        const totalPaid = (paymentRows || []).reduce((s: number, p: { amount: number }) => s + (Number(p.amount) || 0), 0);
        const { data: invoiceRow } = await admin
            .from("billing_invoices").select("final_amount").eq("id", row.invoice_id).maybeSingle();
        const finalAmount = Number(invoiceRow?.final_amount) || 0;
        const newStatus = totalPaid >= finalAmount && finalAmount > 0 ? "paid" : (totalPaid > 0 ? "partial" : "sent");
        await admin.from("billing_invoices").update({ status: newStatus }).eq("id", row.invoice_id);
    }

    await admin.from("admin_audit_log").insert({
        admin_email: "stax-webhook", action: "online_refund_or_void", entity: "billing_invoice",
        details: { invoice_ids: touchedInvoiceIds, parent_transaction_id: parentId, kind },
    }).then(() => {}, (e: unknown) => console.error("stax-webhook: audit write failed", e));

    return json({ received: true, anyNew, touchedInvoiceIds }, 200);
});
