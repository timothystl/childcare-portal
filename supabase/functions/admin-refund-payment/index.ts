// ============================================================
// admin-refund-payment — reverses one online card payment
// ============================================================
// Rare, admin-only action: a family paid online and the office needs to
// give it back (double payment, a family withdrawing after paying, etc).
// Same posture as send-invoice / create-payment-session:
//
//   1. The request body carries ONLY a billing_payments row id. The amount
//      reversed is always that row's own amount — never trusted from the
//      caller — and only a payment this app actually processed online
//      (processor = 'authorizenet') can be reversed this way. A hand-entered
//      cash/check/ACH payment has no online counterpart to reverse.
//   2. Caller must hold a valid session AND `full` admin access, matching
//      send-invoice's gate — this moves money back out the door.
//   3. This function does NOT touch billing_payments or the invoice status.
//      It only asks Authorize.net to void or refund the original charge.
//      The actual reversal is recorded by authorizenet-webhook once
//      Authorize.net confirms it — same "request here, record on
//      confirmation" split as the original payment. A refund/void that
//      Authorize.net rejects therefore leaves nothing to undo here.
//   4. Void vs refund is chosen from the transaction's OWN settlement
//      status (read from Authorize.net, not guessed): unsettled →
//      void (no money ever left the family's account); settled → refund
//      (money already moved and has to be sent back). Only a full reversal
//      is supported — no partial refunds, since this is meant for "this
//      payment shouldn't have happened," not partial credits.
//   5. Already-reversed payments are rejected up front (checked against
//      billing_payments.refund_of_payment_id), so double-clicking Refund
//      cannot submit two reversals for the same charge.
//
// Deploy:  supabase functions deploy admin-refund-payment
// Secrets: AUTHORIZENET_API_LOGIN_ID, AUTHORIZENET_TRANSACTION_KEY,
//          AUTHORIZENET_ENVIRONMENT
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

async function anetRequest(apiUrl: string, body: unknown): Promise<any> {
    const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const rawText = (await res.text()).replace(/^﻿/, "");
    return JSON.parse(rawText);
}

serve(async (req) => {
    const ch = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: ch });

    try {
        // ── 1. Caller must hold a full-admin session ────────────
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) return json({ error: "Unauthorized" }, 401, ch);

        const callerClient = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_ANON_KEY")!,
            { global: { headers: { Authorization: authHeader } } },
        );
        const { data: { user }, error: authError } = await callerClient.auth.getUser();
        if (authError || !user) return json({ error: "Unauthorized" }, 401, ch);

        const admin = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );

        const { data: rolesRow } = await admin
            .from("settings").select("value").eq("key", "admin_roles").maybeSingle();
        let roles: Record<string, string> = {};
        const rawRoles = rolesRow?.value;
        if (rawRoles) {
            roles = typeof rawRoles === "string" ? (JSON.parse(rawRoles) || {}) : rawRoles;
        }
        const callerEmail = (user.email || "").toLowerCase().trim();
        const hasRules = Object.keys(roles).length > 0;
        const callerRole = hasRules ? (roles[callerEmail] || "staff") : "full";
        if (callerRole !== "full") {
            return json({ error: "Full admin access is required to refund a payment." }, 403, ch);
        }

        // ── 2. Input: a billing_payments row id, nothing else ───
        const body = await req.json().catch(() => ({}));
        const paymentId = Number(body?.paymentId);
        if (!Number.isFinite(paymentId)) return json({ error: "paymentId is required." }, 400, ch);

        const { data: payment, error: payErr } = await admin
            .from("billing_payments")
            .select("id, invoice_id, amount, processor, processor_transaction_id, refund_of_payment_id")
            .eq("id", paymentId)
            .maybeSingle();
        if (payErr) return json({ error: payErr.message }, 500, ch);
        if (!payment) return json({ error: "Payment not found." }, 404, ch);
        if (payment.processor !== "authorizenet" || !payment.processor_transaction_id) {
            return json({ error: "Only an online card payment can be reversed this way." }, 400, ch);
        }
        if (payment.refund_of_payment_id) {
            return json({ error: "This is itself a refund/void — it cannot be reversed again." }, 400, ch);
        }
        if (!(Number(payment.amount) > 0)) {
            return json({ error: "Nothing to reverse — this payment is not a positive charge." }, 400, ch);
        }

        const { data: existingReversal } = await admin
            .from("billing_payments").select("id").eq("refund_of_payment_id", paymentId).maybeSingle();
        if (existingReversal) {
            return json({ error: "This payment has already been refunded or voided." }, 400, ch);
        }

        // ── 3. Look up the transaction's own settlement status ──
        const env = (Deno.env.get("AUTHORIZENET_ENVIRONMENT") || "sandbox").toLowerCase();
        const apiUrl = ANET_API_URL[env as "sandbox" | "production"] || ANET_API_URL.sandbox;
        const loginId = Deno.env.get("AUTHORIZENET_API_LOGIN_ID");
        const transactionKey = Deno.env.get("AUTHORIZENET_TRANSACTION_KEY");
        if (!loginId || !transactionKey) {
            return json({ error: "Payment processing is not configured." }, 500, ch);
        }
        const merchantAuthentication = { name: loginId, transactionKey };

        const detail = await anetRequest(apiUrl, {
            getTransactionDetailsRequest: { merchantAuthentication, transId: payment.processor_transaction_id },
        }).catch(() => null);
        const tx = detail?.transaction;
        if (!tx || detail?.messages?.resultCode !== "Ok") {
            return json({ error: "Could not look up this transaction with the payment processor." }, 502, ch);
        }

        const status = String(tx.transactionStatus || "");
        const isUnsettled = ["capturedPendingSettlement", "authorizedPendingCapture"].includes(status);
        const isSettled = status === "settledSuccessfully";
        if (!isUnsettled && !isSettled) {
            return json({ error: `This transaction is in status "${status}" and cannot be refunded or voided here.` }, 400, ch);
        }

        let result: any;
        let kind: "void" | "refund";
        if (isUnsettled) {
            kind = "void";
            result = await anetRequest(apiUrl, {
                createTransactionRequest: {
                    merchantAuthentication,
                    transactionRequest: {
                        transactionType: "voidTransaction",
                        refTransId: payment.processor_transaction_id,
                    },
                },
            });
        } else {
            kind = "refund";
            // Card last-4 from Authorize.net's own record of the transaction —
            // required to refund by reference, never asked of the caller.
            const maskedCard: string = tx?.payment?.creditCard?.cardNumber || "";
            const last4 = maskedCard.slice(-4);
            result = await anetRequest(apiUrl, {
                createTransactionRequest: {
                    merchantAuthentication,
                    transactionRequest: {
                        transactionType: "refundTransaction",
                        amount: (Math.round(Number(payment.amount) * 100) / 100).toFixed(2),
                        payment: { creditCard: { cardNumber: last4 || "0000", expirationDate: "XXXX" } },
                        refTransId: payment.processor_transaction_id,
                    },
                },
            });
        }

        const txResp = result?.transactionResponse;
        const ok = result?.messages?.resultCode === "Ok" && String(txResp?.responseCode) === "1";

        await admin.from("admin_audit_log").insert({
            admin_email: callerEmail,
            action:      `${kind}_attempt`,
            entity:      "billing_payment",
            details:     { payment_id: paymentId, kind, ok, anet_transaction_id: txResp?.transId || null },
        }).then(() => {}, (e: unknown) => console.error("admin-refund-payment: audit write failed", e));

        if (!ok) {
            const msg = txResp?.errors?.[0]?.errorText
                || result?.messages?.message?.[0]?.text
                || "Payment processor declined the request.";
            return json({ error: msg }, 502, ch);
        }

        // Confirmation, not completion — authorizenet-webhook records the
        // actual reversal once Authorize.net's own event arrives.
        return json({ submitted: true, kind, processorTransactionId: txResp?.transId }, 200, ch);

    } catch (err) {
        return json({ error: (err as Error).message }, 500, ch);
    }
});
