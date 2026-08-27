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
// ⚠️ REWRITTEN 2026-08-27 against Stax's own API reference (the original
// version of this file was written from general API-reference reading and
// its two central assumptions were both wrong — see below). Still not
// exercised against a real webhook delivery; see the registration note at
// the bottom before treating this as verified.
//
//   1. STAX HAS NO HMAC SIGNATURE SCHEME AT ALL. Confirmed against the
//      webhook resource's own schema (GET /webhook/{id} returns only
//      {id, user_id, merchant_id, reference_id, url, event, created_at,
//      updated_at, deleted_at} — no secret/signing field of any kind), and
//      against the webhook creation endpoint (only target_url and event —
//      no secret parameter). Stax's own docs describe the actual model:
//      "you can generate a secret key in your URL that you can modify to
//      add additional security" — i.e. THE SECRET IS SOMETHING *WE* EMBED
//      IN THE REGISTERED target_url OURSELVES, checked as a query string on
//      the way in, not a signature Stax computes over the body. The
//      original version of this file checked a custom header
//      (X-Stax-Webhook-Secret) that Stax has no mechanism to ever send.
//   2. STAX HAS NO DEDICATED refund/void EVENT NAME. The only events
//      Stax's webhook creation endpoint accepts are a fixed list —
//      create_transaction, update_transaction, update_transaction_settled,
//      create_dispute, update_dispute, etc. — with no refund/void event of
//      its own. A refund or void instead shows up as an update_transaction
//      on the ORIGINAL charge: POST /transaction/{id}/refund "returns the
//      original transaction object with an added child transaction of
//      type = refund" (confirmed from the refund-transaction and
//      void-or-refund-transaction endpoint docs), so this function is
//      registered for update_transaction and reads the parent transaction's
//      own child_transactions[] array rather than looking for a "refund
//      event" that does not exist. Each child carries its own id, a type
//      of "refund" or "void", a reference_id pointing back at the parent,
//      and a total.
//   3. Idempotent by construction — billing_payments_processor_txn_idx
//      (processor, processor_transaction_id) is a unique index, so a
//      retried webhook cannot double-record the same event, matching
//      authorizenet-webhook.
//   4. ⚠️ May reverse SEVERAL billing_payments rows per Stax transaction
//      (2026-08-27) — charge-stax-payment's allocateAcrossDueSet can split
//      one real Stax charge across multiple invoices (a family's own
//      rollup), suffixing each row's processor_transaction_id with
//      "-inv<invoiceId>". A refund/void event names the PARENT transaction's
//      bare id, so this looks up every row matching that bare id OR any
//      "<id>-inv*" suffix (findOriginalPaymentRows, same helper shape as
//      authorizenet-webhook's) and allocates the refund/void total across
//      them oldest-invoice-first, capped per row.
//   5. A refund/void is recorded as its OWN negative billing_payments row
//      per original row it reverses (refund_of_payment_id pointing at that
//      row), never by editing the original — same rule as
//      authorizenet-webhook.
//   6. Only an event tied to a transaction id this app actually recorded
//      (processor='stax') is acted on — a refund for a transaction we have
//      no record of is logged and ignored rather than guessed at.
//
// ⚠️ STILL UNVERIFIED AGAINST A REAL DELIVERY. The rewrite above corrects
// the two things that were provably wrong (the auth mechanism and the
// event/payload shape) against Stax's documented API, but no webhook has
// actually been registered with Stax or fired yet — that requires:
//   (a) picking a STAX_WEBHOOK_SECRET value and setting it as a project
//       secret (dashboard-only, same as STAX_WEB_PAYMENTS_TOKEN earlier);
//   (b) calling Stax's create-webhook endpoint with
//       target_url = "<this function's URL>?secret=<that value>" and
//       event = "update_transaction";
//   (c) issuing a real refund (POST /transaction/{id}/refund) against a
//       transaction this app actually charged, and confirming the POST
//       Stax sends here matches the child_transactions[] shape assumed
//       above — Stax's own docs never show a concrete example payload, so
//       this is the best-documented shape available, not a confirmed one.
// Do this before relying on it for anything beyond a same-session test.
//
// Deploy:  supabase functions deploy stax-webhook --no-verify-jwt
//          (called by Stax, not a signed-in user — auth is the URL secret)
// Secrets: STAX_WEBHOOK_SECRET (the value embedded in the registered
//          target_url's ?secret= query param — see (a)/(b) above)
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

    // stax-event-name identifies which subscribed event fired. This function
    // is registered only for update_transaction; ignore anything else rather
    // than assume a shape for an event it was never meant to receive.
    const eventName = req.headers.get("stax-event-name") || "";
    if (eventName && eventName !== "update_transaction") {
        return json({ received: true, ignored: eventName }, 200);
    }

    // The POST body is the transaction object itself (Stax's docs: a
    // webhook "returns the associated object for the event"). Reversals
    // show up as entries in its own child_transactions[] pointing back at
    // this same id — see header point 2.
    const parentId = String(body?.id || "");
    const children: any[] = Array.isArray(body?.child_transactions) ? body.child_transactions : [];
    const reversals = children.filter((c: any) =>
        /^(refund|void)$/i.test(String(c?.type || "")) && String(c?.reference_id || "") === parentId
    );
    if (!parentId || !reversals.length) {
        return json({ received: true, ignored: "no reversal child transactions" }, 200);
    }

    const admin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const originalRows = await findOriginalPaymentRows(admin, parentId);
    if (!originalRows.length) return json({ received: true, ignored: "unknown original transaction" }, 200);

    let anyNew = false;
    const touchedInvoiceIds: number[] = [];

    for (const child of reversals) {
        const childId = String(child.id || "");
        const kind = String(child.type || "").toLowerCase();
        if (!childId) continue;
        let remaining = Math.round((Number(child.total) || 0) * 100) / 100;
        if (remaining <= 0.004) continue;

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
    }

    await admin.from("admin_audit_log").insert({
        admin_email: "stax-webhook", action: "online_refund_or_void", entity: "billing_invoice",
        details: { invoice_ids: touchedInvoiceIds, parent_transaction_id: parentId },
    }).then(() => {}, (e: unknown) => console.error("stax-webhook: audit write failed", e));

    return json({ received: true, anyNew, touchedInvoiceIds }, 200);
});
