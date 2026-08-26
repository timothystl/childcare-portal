// ============================================================
// charge-stax-payment — actually moves money, via Stax
// ============================================================
// Scaffolding, not yet live-tested — see the ⚠️ block below.
//
// Second half of the Stax flow: create-stax-charge got the browser a Stax
// customer id and a key for Stax.js (Bolt) to tokenize a card into a
// payment_method id. This function takes that payment_method id — never
// raw card data — and actually charges it.
//
//   1. The request body carries an invoice id and a Stax payment_method
//      id. The amount charged is always (final_amount - sum of recorded
//      payments), recomputed here from the database — never trusted from
//      the caller, same as create-stax-charge and create-payment-session.
//   2. Same ownership/status checks as create-stax-charge: caller must
//      hold a parent session, the invoice must belong to their own
//      family, and it must be issued (sent_at set, status sent/partial).
//   3. Unlike Authorize.net's Hosted Payment Page (redirect + async
//      webhook), Stax's /charge call is synchronous — its response tells
//      us immediately whether the charge succeeded. So this function DOES
//      record the billing_payments row itself, on a confirmed-successful
//      response only. billing_payments_processor_txn_idx (processor,
//      processor_transaction_id) — already in place for Authorize.net —
//      makes a retried request idempotent here too: the same Stax
//      transaction id can only ever be recorded once.
//   4. A Stax webhook (stax-webhook, scaffolded alongside this) still
//      exists for anything that happens AFTER this synchronous response —
//      a later refund or chargeback — the same "processor's own
//      confirmation, not the browser, is authoritative" instinct as
//      authorizenet-webhook, just triggered by the charge call's own
//      response instead of by a redirect return.
//
// ⚠️ UNTESTED — Stax sandbox merchant not yet activated (2026-08-26), see
//   create-stax-charge's header for the full status. In particular:
//   re-confirm the exact /charge request/response shape (field names for
//   amount, customer_id, payment_method_id, and where the transaction id
//   and success flag live in the response body) against
//   https://docs.staxpayments.com/reference once a real sandbox call can
//   be made — this was written from the API reference, not a working call.
//
// Deploy:  supabase functions deploy charge-stax-payment
// Secrets: STAX_API_KEY
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://mdo.timothystl.org";
const STAX_API_URL = "https://apiprod.fattlabs.com";

function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("origin") || "";
    return {
        "Access-Control-Allow-Origin":  origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    };
}

function json(body: unknown, status: number, ch: Record<string, string>) {
    return new Response(JSON.stringify(body), {
        status, headers: { ...ch, "Content-Type": "application/json" },
    });
}

/** Stax wants a decimal dollar amount, same shape as Authorize.net's. */
function amountStr(n: number): string {
    return (Math.round(n * 100) / 100).toFixed(2);
}

serve(async (req) => {
    const ch = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: ch });

    try {
        // ── 1. Caller must hold a parent session ──────────────────
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) return json({ error: "Unauthorized" }, 401, ch);

        const callerClient = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_ANON_KEY")!,
            { global: { headers: { Authorization: authHeader } } },
        );
        const { data: { user }, error: authError } = await callerClient.auth.getUser();
        if (authError || !user) return json({ error: "Unauthorized" }, 401, ch);

        const { data: famIdRows, error: famIdErr } = await callerClient.rpc("parent_family_ids");
        if (famIdErr) return json({ error: "Could not resolve your family." }, 403, ch);
        const myFamilyIds = new Set((famIdRows || []).map((r: unknown) => String(r)));
        if (!myFamilyIds.size) return json({ error: "No family is linked to this account." }, 403, ch);

        // ── 2. Input: an invoice id + the tokenized payment method ─
        const body = await req.json().catch(() => ({}));
        const invoiceId = Number(body?.invoiceId);
        const paymentMethodId = String(body?.paymentMethodId || "");
        if (!Number.isFinite(invoiceId)) return json({ error: "invoiceId is required." }, 400, ch);
        if (!paymentMethodId) return json({ error: "paymentMethodId is required." }, 400, ch);

        const admin = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );

        const { data: invoice, error: invErr } = await admin
            .from("billing_invoices")
            .select("id, family_id, final_amount, status, sent_at, billing_cycles(month)")
            .eq("id", invoiceId)
            .maybeSingle();
        if (invErr) return json({ error: invErr.message }, 500, ch);
        if (!invoice) return json({ error: "Invoice not found." }, 404, ch);
        if (!myFamilyIds.has(String(invoice.family_id))) {
            return json({ error: "That invoice does not belong to your family." }, 403, ch);
        }
        if (!invoice.sent_at || !["sent", "partial"].includes(invoice.status)) {
            return json({ error: "This bill has not been issued yet." }, 400, ch);
        }

        const { data: family, error: famErr } = await admin
            .from("families")
            .select("id, stax_customer_id")
            .eq("id", invoice.family_id)
            .maybeSingle();
        if (famErr) return json({ error: famErr.message }, 500, ch);
        if (!family?.stax_customer_id) {
            return json({ error: "Start a payment session before charging." }, 400, ch);
        }

        const { data: paymentRows, error: payErr } = await admin
            .from("billing_payments")
            .select("amount")
            .eq("invoice_id", invoiceId);
        if (payErr) return json({ error: payErr.message }, 500, ch);
        const paid = (paymentRows || []).reduce((s: number, p: { amount: number }) => s + (Number(p.amount) || 0), 0);
        const due = Math.round(((Number(invoice.final_amount) || 0) - paid) * 100) / 100;
        if (due <= 0) return json({ error: "This bill is already paid in full." }, 400, ch);

        // ── 3. Charge it ────────────────────────────────────────────
        const apiKey = Deno.env.get("STAX_API_KEY");
        if (!apiKey) return json({ error: "Payment processing is not configured yet." }, 500, ch);

        const month = (invoice as unknown as { billing_cycles?: { month?: string } }).billing_cycles?.month || "";

        const chargeRes = await fetch(`${STAX_API_URL}/charge`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                payment_method_id: paymentMethodId,
                customer_id: family.stax_customer_id,
                total: amountStr(due),
                pre_auth: false,
                meta: {
                    memo: `Timothy Lutheran MDO — ${month} — invoice ${invoice.id}`,
                    reference: `mdoinv-${invoice.id}`,
                },
            }),
        });
        const chargeData = await chargeRes.json().catch(() => ({}));

        // ⚠️ success/id field names are unverified — see header. Adjust once
        // a real sandbox response can be inspected.
        const success = chargeRes.ok && chargeData?.success !== false && !!chargeData?.id;
        if (!success) {
            const msg = chargeData?.errors ? JSON.stringify(chargeData.errors) : "Payment was declined.";
            return json({ error: msg }, 502, ch);
        }

        const transactionId = String(chargeData.id);

        // Idempotent insert — a retry with the same Stax transaction id
        // hits billing_payments_processor_txn_idx and is treated as
        // already-recorded rather than double-charging the invoice. Column
        // shape matches recordAndReconcile() in authorizenet-webhook so
        // both processors write the same table the same way.
        const { error: insErr } = await admin.from("billing_payments").insert({
            family_id: invoice.family_id,
            invoice_id: invoice.id,
            amount: due,
            payment_date: new Date().toISOString().slice(0, 10),
            payment_method: "card",
            note: `Stax online payment — invoice ${invoice.id}`,
            created_by: "charge-stax-payment",
            processor: "stax",
            processor_transaction_id: transactionId,
        });
        if (insErr && String(insErr.code) !== "23505" && !/duplicate key/i.test(insErr.message || "")) {
            // The charge succeeded at Stax but we failed to record it —
            // surface this loudly rather than silently losing the payment.
            return json({ error: "Payment succeeded but could not be recorded. Contact the office." }, 500, ch);
        }

        // Recompute invoice status the same way recordAndReconcile() does —
        // keep both processors' post-payment logic identical.
        const { data: paymentRows2 } = await admin
            .from("billing_payments").select("amount").eq("invoice_id", invoice.id);
        const totalPaid = (paymentRows2 || []).reduce((s: number, p: { amount: number }) => s + (Number(p.amount) || 0), 0);
        const newStatus = totalPaid >= (Number(invoice.final_amount) || 0) && Number(invoice.final_amount) > 0
            ? "paid" : (totalPaid > 0 ? "partial" : "sent");
        await admin.from("billing_invoices").update({ status: newStatus }).eq("id", invoice.id);

        return json({ success: true, transactionId, amount: due }, 200, ch);

    } catch (err) {
        return json({ error: (err as Error).message }, 500, ch);
    }
});
