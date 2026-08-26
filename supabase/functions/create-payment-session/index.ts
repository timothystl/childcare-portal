// ============================================================
// create-payment-session — starts an Authorize.net Accept Hosted payment
// ============================================================
// The first "family clicks pay" step in this app. Mirrors send-invoice's
// security posture, because it is the same class of problem: a function
// that must never be aimable at an arbitrary amount or account.
//
//   1. The request body carries ONLY an invoice id. The amount charged is
//      always (final_amount - sum of recorded payments), computed here from
//      the database — never trusted from the caller.
//   2. The caller must hold a valid parent session AND that invoice must
//      belong to their own family (checked via parent_family_ids(), the
//      same definer RPC every other parent-facing read already trusts).
//      A parent cannot start a payment session for another family's bill.
//   3. Only an ISSUED invoice (sent_at set, status 'sent' or 'partial') can
//      be paid. A draft is the office still working the month out — see
//      the "A DRAFT INVOICE IS NOT A BILL" note in portal-billing.js.
//   4. Authorize.net's own hosted page collects the card; this function
//      never sees card data, keeping the app at PCI SAQ A.
//   5. This function does NOT mark anything paid. Only the
//      authorizenet-webhook function does that, after Authorize.net itself
//      confirms the charge. A parent closing the tab mid-payment leaves the
//      invoice exactly as it was.
//
// Deploy:  supabase functions deploy create-payment-session
// Secrets: AUTHORIZENET_API_LOGIN_ID, AUTHORIZENET_TRANSACTION_KEY,
//          AUTHORIZENET_ENVIRONMENT ('sandbox' | 'production', default sandbox)
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://mdo.timothystl.org";

const ANET_API_URL = {
    sandbox:    "https://apitest.authorize.net/xml/v1/request.api",
    production: "https://api.authorize.net/xml/v1/request.api",
};

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

/** Authorize.net wants a plain decimal string, min 0.01. */
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

        // The caller's own family ids, resolved server-side via the definer
        // RPC every other parent read already trusts (parent_portal_option_b
        // _accounts_APPLIED.sql). A parent with no family mapping gets none.
        const { data: famIdRows, error: famIdErr } = await callerClient.rpc("parent_family_ids");
        if (famIdErr) return json({ error: "Could not resolve your family." }, 403, ch);
        const myFamilyIds = new Set((famIdRows || []).map((r: unknown) => String(r)));
        if (!myFamilyIds.size) return json({ error: "No family is linked to this account." }, 403, ch);

        // ── 2. Input: an invoice id, nothing else ──────────────────
        const body = await req.json().catch(() => ({}));
        const invoiceId = Number(body?.invoiceId);
        if (!Number.isFinite(invoiceId)) return json({ error: "invoiceId is required." }, 400, ch);

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

        const { data: paymentRows, error: payErr } = await admin
            .from("billing_payments")
            .select("amount")
            .eq("invoice_id", invoiceId);
        if (payErr) return json({ error: payErr.message }, 500, ch);
        const paid = (paymentRows || []).reduce((s: number, p: { amount: number }) => s + (Number(p.amount) || 0), 0);
        const due = Math.round(((Number(invoice.final_amount) || 0) - paid) * 100) / 100;
        if (due <= 0) return json({ error: "This bill is already paid in full." }, 400, ch);

        // ── 3. Ask Authorize.net for a Hosted Payment Page token ───
        const env = (Deno.env.get("AUTHORIZENET_ENVIRONMENT") || "sandbox").toLowerCase();
        const apiUrl = ANET_API_URL[env as "sandbox" | "production"] || ANET_API_URL.sandbox;
        const loginId = Deno.env.get("AUTHORIZENET_API_LOGIN_ID");
        const transactionKey = Deno.env.get("AUTHORIZENET_TRANSACTION_KEY");
        if (!loginId || !transactionKey) {
            return json({ error: "Payment processing is not configured yet." }, 500, ch);
        }

        const returnBase = Deno.env.get("PAYMENT_RETURN_URL") || `${ALLOWED_ORIGIN}/portal.html`;
        const month = (invoice as unknown as { billing_cycles?: { month?: string } }).billing_cycles?.month || "";

        const anetReq = {
            getHostedPaymentPageRequest: {
                merchantAuthentication: { name: loginId, transactionKey },
                transactionRequest: {
                    transactionType: "authCaptureTransaction",
                    amount: amountStr(due),
                    order: {
                        // Capped at 20 chars by Authorize.net; invoice ids here are
                        // small so this fits comfortably.
                        invoiceNumber: `mdoinv-${invoice.id}`,
                        description: `Timothy Lutheran MDO — ${month}`,
                    },
                },
                hostedPaymentSettings: {
                    setting: [
                        { settingName: "hostedPaymentReturnOptions", settingValue: JSON.stringify({
                            showReceipt: false,
                            // A real query string, not a hash fragment — portal-auth.js
                            // reads location.search (see its return-URL handling), and a
                            // hash-only param would never be seen there.
                            url: `${returnBase}?paid=${invoice.id}`,
                            urlText: "Return to portal",
                            cancelUrl: `${returnBase}?cancelled=${invoice.id}`,
                            cancelUrlText: "Cancel",
                        }) },
                        { settingName: "hostedPaymentOrderOptions", settingValue: JSON.stringify({
                            show: true, merchantName: "Timothy Lutheran MDO",
                        }) },
                        { settingName: "hostedPaymentBillingAddressOptions", settingValue: JSON.stringify({
                            show: false, required: false,
                        }) },
                        { settingName: "hostedPaymentPaymentOptions", settingValue: JSON.stringify({
                            cardCodeRequired: true, showCreditCard: true, showBankAccount: false,
                        }) },
                    ],
                },
            },
        };

        const anetRes = await fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(anetReq),
        });
        // Authorize.net prefixes JSON responses with a UTF-8 BOM.
        const rawText = (await anetRes.text()).replace(/^﻿/, "");
        let anetData: any;
        try { anetData = JSON.parse(rawText); } catch { return json({ error: "Payment processor returned an unreadable response." }, 502, ch); }

        if (anetData?.messages?.resultCode !== "Ok" || !anetData?.token) {
            const msg = anetData?.messages?.message?.[0]?.text || "Payment processor declined the request.";
            return json({ error: msg }, 502, ch);
        }

        return json({
            token: anetData.token,
            formUrl: env === "production"
                ? "https://accept.authorize.net/payment/payment"
                : "https://test.authorize.net/payment/payment",
            amount: due,
        }, 200, ch);

    } catch (err) {
        return json({ error: (err as Error).message }, 500, ch);
    }
});
