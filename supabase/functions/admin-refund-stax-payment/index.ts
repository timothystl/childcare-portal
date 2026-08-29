// ============================================================
// admin-refund-stax-payment — reverses one online Stax card payment
// ============================================================
// Stax counterpart to admin-refund-payment (Authorize.net). Same posture:
//
//   1. The request body carries ONLY a billing_payments row id. The amount
//      reversed is always that row's own amount — never trusted from the
//      caller — and only a payment this app actually processed online via
//      Stax (processor = 'stax') can be reversed this way.
//   2. Caller must hold a valid session AND `full` admin access, matching
//      admin-refund-payment's gate — this moves money back out the door.
//   3. This function does NOT touch billing_payments or the invoice status.
//      It only asks Stax to void or refund the original charge. The actual
//      reversal is recorded by stax-webhook once Stax's own create_transaction
//      event for the refund/void arrives and is independently re-verified
//      against Stax's authenticated API — same "request here, record on
//      confirmation" split as the Authorize.net path.
//   4. Void vs refund starts from the transaction's OWN is_voidable flag,
//      read fresh from Stax (never guessed locally): voidable → void (no
//      money ever left the family's account); otherwise → refund (money
//      already batched/settled and has to be sent back). ⚠️ That flag can
//      be stale relative to the gateway's actual daily batch cutoff — seen
//      live 2026-08-29, a transaction still reported is_voidable:true after
//      its batch had actually closed, and the void call was rejected
//      ("gateway response: Batch Closed"). A void failure therefore retries
//      once as a refund before giving up. Only a full reversal is
//      supported — no partial refunds, matching admin-refund-payment's
//      "this payment shouldn't have happened" scope.
//   5. Already-reversed payments are rejected up front (checked against
//      billing_payments.refund_of_payment_id), so double-clicking Refund
//      cannot submit two reversals for the same charge.
//   6. billing_payments.processor_transaction_id may carry this app's own
//      "-inv<id>" (a charge rolled across several invoices) or "-credit"
//      suffix — see stax_finalize_charge in harden_stax_payments.sql. The
//      real Stax transaction id is everything before that suffix; the
//      suffix itself is never sent to Stax's API.
//
// Deploy:  supabase functions deploy admin-refund-stax-payment
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
        status, headers: { ...ch, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
}

// Strips this app's own "-inv<id>" or "-credit" suffix (see
// stax_finalize_charge) to recover the real Stax transaction id.
function baseTransactionId(processorTransactionId: string): string {
    return processorTransactionId.replace(/-inv\d+$/, "").replace(/-credit$/, "");
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
        if (payment.processor !== "stax" || !payment.processor_transaction_id) {
            return json({ error: "Only an online Stax card payment can be reversed this way." }, 400, ch);
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

        const apiKey = Deno.env.get("STAX_API_KEY");
        if (!apiKey) return json({ error: "Payment processing is not configured." }, 500, ch);
        const transactionId = baseTransactionId(payment.processor_transaction_id);

        // ── 3. Look up the transaction's own voidability, from Stax ─
        const lookupRes = await fetch(`${STAX_API_URL}/transaction/${encodeURIComponent(transactionId)}`, {
            headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
        }).catch(() => null);
        const lookupBody = lookupRes ? await lookupRes.json().catch(() => ({})) : {};
        if (!lookupRes || !lookupRes.ok) {
            return json({ error: "Could not look up this transaction with the payment processor." }, 502, ch);
        }
        const tx = lookupBody?.data && typeof lookupBody.data === "object" ? lookupBody.data : lookupBody;
        if (!tx || String(tx.id || "") !== transactionId) {
            return json({ error: "Could not verify this transaction with the payment processor." }, 502, ch);
        }
        if (tx.is_refunded === true || tx.is_voided === true) {
            return json({ error: "The payment processor already shows this payment as reversed." }, 400, ch);
        }

        // Extracts a human-readable error from any of the shapes Stax's API
        // actually returns. A void/refund failure often comes back as the
        // FULL transaction object (200-shaped, not a bare {error}) with the
        // real reason nested in the most recent child_transactions[] entry
        // — e.g. a rejected void reads {..., child_transactions: [{type:
        // "void", success: false, error_description: "gateway response:
        // Batch Closed"}]}. Verified live 2026-08-29 against a real
        // sandbox decline; a bare {error}/{errors} check alone missed it
        // and fell through to a useless generic message.
        function staxErrorMessage(body: any): string | null {
            if (!body || typeof body !== "object") return null;
            if (typeof body.error === "string" && body.error) return body.error;
            if (Array.isArray(body.errors)) return body.errors.join(", ");
            if (body.errors && typeof body.errors === "object") {
                return Object.values(body.errors).flat().join(", ");
            }
            const lastChild = Array.isArray(body.child_transactions)
                ? body.child_transactions[body.child_transactions.length - 1] : null;
            return lastChild?.error_description || lastChild?.message
                || body.error_description || body.message || null;
        }

        async function postVoidOrRefund(kind: "void" | "refund"): Promise<{ res: Response; body: any }> {
            const res = kind === "void"
                ? await fetch(`${STAX_API_URL}/transaction/${encodeURIComponent(transactionId)}/void`, {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
                })
                : await fetch(`${STAX_API_URL}/transaction/${encodeURIComponent(transactionId)}/refund`, {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${apiKey}`,
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ total: Number(payment.amount).toFixed(2) }),
                });
            const resBody = await res.json().catch(() => ({}));
            return { res, body: resBody };
        }

        let kind: "void" | "refund" = tx.is_voidable === true ? "void" : "refund";
        let { res: reverseRes, body: reverseBody } = await postVoidOrRefund(kind);

        // Stax's own `is_voidable` flag can be stale relative to the
        // gateway's actual daily batch-cutoff state — seen live: the GET
        // reported is_voidable:true, but by the time this ran, BlockChyp
        // had already closed the transaction's batch and rejected the void
        // with "gateway response: Batch Closed". Rather than surface a raw
        // gateway decline for something the flag told us should have
        // worked, retry once as a refund — the correct action once a
        // transaction has actually settled — before giving up.
        if (kind === "void" && !reverseRes.ok) {
            kind = "refund";
            ({ res: reverseRes, body: reverseBody } = await postVoidOrRefund(kind));
        }

        await admin.from("admin_audit_log").insert({
            admin_email: callerEmail,
            action:      `${kind}_attempt`,
            entity:      "billing_payment",
            details:     { payment_id: paymentId, kind, ok: reverseRes.ok, stax_transaction_id: transactionId },
        }).then(() => {}, (e: unknown) => console.error("admin-refund-stax-payment: audit write failed", e));

        if (!reverseRes.ok) {
            const msg = staxErrorMessage(reverseBody) || "Payment processor declined the request.";
            return json({ error: msg }, 502, ch);
        }

        // Confirmation, not completion — stax-webhook records the actual
        // reversal once Stax's own event arrives and is re-verified.
        return json({ submitted: true, kind, processorTransactionId: transactionId }, 200, ch);

    } catch (err) {
        return json({ error: (err as Error).message }, 500, ch);
    }
});
