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
//   6. hostedPaymentIFrameCommunicatorUrl points at /iframe-communicator.html
//      on our own domain, which is what lets portal-billing.js embed the
//      hosted form in an iframe instead of redirecting the whole page —
//      paying never leaves the portal. Card data still never touches our
//      server; the iframe just relays Authorize.net's own result back to us.
//      See portal-billing.js's CommunicationHandler for the receiving end.
//   7. ⚠️ ROLLS UP OLDER UNPAID MONTHS (2026-08-27). Paying invoice X now
//      charges X's own balance PLUS any still-unpaid invoice for an EARLIER
//      month for the same family — never a later one. A family with two
//      unpaid months no longer has to click Pay twice, and can't quietly
//      leave an old month unpaid while paying only the newest one. See
//      computeFamilyDueSet(). authorizenet-webhook allocates the one
//      settled amount back across every invoice this due-set covered,
//      oldest first.
//   8. Itemized via compute_family_month_charges_itemized() — the SAME
//      per-child discount-aware computation compute_family_month_charges()
//      already does internally, just returned per child instead of summed.
//      Never a second, hand-rolled copy of the rate/discount math.
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

type DueRow = { id: number; due: number; month: string };

/**
 * Every still-owed invoice for this family, from the oldest unpaid month
 * through anchorMonth (inclusive) — never a month AFTER anchorMonth, so
 * paying an old bill never reaches forward and charges a future one.
 * Shared shape with charge-stax-payment's copy; kept duplicated per this
 * repo's no-shared-module convention for edge functions.
 */
async function computeFamilyDueSet(admin: any, familyId: string, anchorMonth: string): Promise<DueRow[]> {
    const { data: invoices } = await admin
        .from("billing_invoices")
        .select("id, final_amount, status, sent_at, billing_cycles(month)")
        .eq("family_id", familyId)
        .not("sent_at", "is", null)
        .in("status", ["sent", "partial"]);

    const eligible = (invoices || []).filter((inv: any) => {
        const m = inv?.billing_cycles?.month;
        return typeof m === "string" && m.slice(0, 7) <= anchorMonth;
    });
    if (!eligible.length) return [];

    const ids = eligible.map((inv: any) => inv.id);
    const { data: pays } = await admin.from("billing_payments").select("invoice_id, amount").in("invoice_id", ids);
    const paidByInvoice = new Map<number, number>();
    for (const p of (pays || [])) {
        paidByInvoice.set(p.invoice_id, (paidByInvoice.get(p.invoice_id) || 0) + (Number(p.amount) || 0));
    }

    const rows: DueRow[] = eligible.map((inv: any) => {
        const paid = paidByInvoice.get(inv.id) || 0;
        const due = Math.round(((Number(inv.final_amount) || 0) - paid) * 100) / 100;
        return { id: inv.id as number, due, month: String(inv.billing_cycles.month).slice(0, 7) };
    }).filter((r: DueRow) => r.due > 0.004);

    rows.sort((a, b) => a.month.localeCompare(b.month));
    return rows;
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

        const month = (invoice as unknown as { billing_cycles?: { month?: string } }).billing_cycles?.month || "";
        const anchorMonth = String(month).slice(0, 7);

        const dueSet = await computeFamilyDueSet(admin, String(invoice.family_id), anchorMonth);
        if (!dueSet.length) return json({ error: "This bill is already paid in full." }, 400, ch);
        const due = Math.round(dueSet.reduce((s, r) => s + r.due, 0) * 100) / 100;
        const priorBalance = Math.round(
            dueSet.filter(r => r.month < anchorMonth).reduce((s, r) => s + r.due, 0) * 100,
        ) / 100;

        // ── 3. Itemized lines — same per-child math the invoice total
        // itself was computed from, never a second hand-rolled copy.
        const { data: itemRows } = await admin.rpc("compute_family_month_charges_itemized", {
            p_family_id: invoice.family_id, p_month: anchorMonth,
        });
        const lineItem = (itemRows || []).slice(0, priorBalance > 0 ? 29 : 30).map((r: any, i: number) => ({
            itemId: `child${i + 1}`,
            name: String(r.child_name || "Child").slice(0, 31),
            description: `${r.full_days || 0} full day(s), ${r.half_days || 0} half day(s)`.slice(0, 250),
            quantity: "1",
            unitPrice: amountStr(Number(r.net) || 0),
        }));
        if (priorBalance > 0) {
            lineItem.push({
                itemId: "priorbal",
                name: "Prior balance",
                description: "Balance carried from an earlier month's bill",
                quantity: "1",
                unitPrice: amountStr(priorBalance),
            });
        }

        // ── 4. Ask Authorize.net for a Hosted Payment Page token ───
        const env = (Deno.env.get("AUTHORIZENET_ENVIRONMENT") || "sandbox").toLowerCase();
        const apiUrl = ANET_API_URL[env as "sandbox" | "production"] || ANET_API_URL.sandbox;
        const loginId = Deno.env.get("AUTHORIZENET_API_LOGIN_ID");
        const transactionKey = Deno.env.get("AUTHORIZENET_TRANSACTION_KEY");
        if (!loginId || !transactionKey) {
            return json({ error: "Payment processing is not configured yet." }, 500, ch);
        }

        const returnBase = Deno.env.get("PAYMENT_RETURN_URL") || `${ALLOWED_ORIGIN}/portal.html`;

        const anetReq = {
            getHostedPaymentPageRequest: {
                merchantAuthentication: { name: loginId, transactionKey },
                transactionRequest: {
                    transactionType: "authCaptureTransaction",
                    amount: amountStr(due),
                    lineItems: lineItem.length ? { lineItem } : undefined,
                    order: {
                        // Capped at 20 chars by Authorize.net; invoice ids here are
                        // small so this fits comfortably.
                        invoiceNumber: `mdoinv-${invoice.id}`,
                        description: priorBalance > 0
                            ? `Timothy Lutheran MDO — ${month} + prior balance`
                            : `Timothy Lutheran MDO — ${month}`,
                    },
                },
                hostedPaymentSettings: {
                    setting: [
                        // Embeds the hosted form in our own iframe instead of a
                        // full-page redirect — see behavior #6 above.
                        { settingName: "hostedPaymentIFrameCommunicatorUrl", settingValue: JSON.stringify({
                            url: `${ALLOWED_ORIGIN}/iframe-communicator.html`,
                        }) },
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
            priorBalance,
        }, 200, ch);

    } catch (err) {
        return json({ error: (err as Error).message }, 500, ch);
    }
});
