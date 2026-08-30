// ============================================================
// create-stax-charge — starts a Stax (fattmerchant) payment
// ============================================================
// Starts an authenticated, server-priced Stax checkout session. The actual
// charge and all payment allocation happen in charge-stax-payment.
//
//   1. The request body carries ONLY an invoice id. A restricted database
//      function computes the issued balance and fails closed on query errors.
//   2. The caller must hold a valid parent session AND that invoice must
//      belong to their own family (parent_family_ids(), same definer RPC
//      every other parent-facing read already trusts).
//   3. Only an ISSUED invoice (sent_at set, status 'sent' or 'partial')
//      can be paid — same rule as create-payment-session.
//   4. This function's job is ONLY to get a customer id and a public
//      tokenization key back to the browser so Stax.js (Bolt) can collect
//      the card and hand back a payment_method id — raw card data must
//      never reach this server, to keep the app at PCI SAQ A the same way
//      the Authorize.net flow does. The actual charge happens in
//      charge-stax-payment, called AFTER the browser has a
//      payment_method id, never with raw card fields.
//
//   5. Rolls up older unpaid months: paying invoice X quotes
//      X's own balance plus any STILL-unpaid invoice for an earlier month,
//      never a later one. See stax_quote_balance() in the hardening migration.
//   6. Itemized via compute_family_month_charges_itemized() — same
//      per-child math compute_family_month_charges() already computes
//      internally; never a second copy of the rate/discount logic.
//   7. Saved-card lookup: if this family already has a saved Stax payment
//      method (add_stax_saved_card.sql), this returns its last4/brand so
//      the browser can offer "pay with the card on file" and skip card
//      entry entirely — charge-stax-payment does the actual charge either
//      way. Nothing here ever sees the card itself, saved or new; only
//      Stax's own opaque payment_method_id and the two PCI-permitted
//      display fields (last4, brand) are stored. The opaque payment-method
//      id itself is never returned to the browser.
//
// Deploy:  supabase functions deploy create-stax-charge
// Secrets: STAX_API_KEY, STAX_WEB_PAYMENTS_TOKEN, STAX_ENVIRONMENT,
//          STAX_PAYMENTS_ENABLED
//          ('sandbox' | 'production', default sandbox)
// Optional: STAX_SANDBOX_TEST_ENABLED=true — deliberate, temporary opt-in
//          for click-testing against the sandbox merchant ahead of a real
//          production Stax account (see the sandbox-test-path comment
//          below). Leave unset/false outside an active test.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://mdo.timothystl.org";

// apiprod.fattlabs.com is Stax's single Core API host for both sandbox and
// production credentials — which environment you hit is determined by
// which API key you send, not by the URL (confirmed against the sandbox
// merchant check run this session). There is no separate sandbox host.
const STAX_API_URL = "https://apiprod.fattlabs.com";

// ⚠️ MERCHANT PIN — the line between test money and real money.
// Sandbox and production share ONE API host (apiprod.fattlabs.com); only the
// key decides which merchant a charge lands on. STAX_ENVIRONMENT is a label
// this code sets for itself, not something Stax confirms — so flipping it to
// "production" while a stale sandbox key is still in place would charge
// nobody at all, while this app recorded a real payment, marked the invoice
// paid and emailed the family a receipt. Nothing downstream could tell.
//
// When STAX_MERCHANT_ID is set, every call verifies the key's own merchant
// against it and refuses on a mismatch OR on an answer it cannot read —
// fail closed, because "could not verify" and "wrong merchant" are the same
// risk here. When it is unset, behavior is unchanged (sandbox testing keeps
// working), which is why setting it is a go-live checklist step and not
// optional: see docs/STAX_GO_LIVE.md.
let _staxMerchantVerified = false;
async function assertStaxMerchant(apiKey: string): Promise<void> {
    const expected = (Deno.env.get("STAX_MERCHANT_ID") || "").trim();
    if (!expected || _staxMerchantVerified) return;
    let body: Record<string, unknown> | null = null;
    try {
        const res = await fetch(`${STAX_API_URL}/self`, {
            headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        });
        if (res.ok) body = await res.json().catch(() => null);
    } catch (_e) {
        body = null;
    }
    // Only a merchant-shaped field counts. A top-level `id` on /self is the
    // API user, not the merchant, and accepting it would compare the wrong
    // thing — better to fail closed and be told so by the checklist step.
    const merchant = (body as { merchant?: { id?: unknown } } | null)?.merchant;
    const actual = String(merchant?.id ?? (body as { merchant_id?: unknown } | null)?.merchant_id ?? "").trim();
    if (!actual) {
        console.error("stax merchant pin: could not read a merchant id from /self");
        throw new Error("Could not verify the payment merchant.");
    }
    if (actual !== expected) {
        console.error(`stax merchant pin: key belongs to ${actual}, expected ${expected}`);
        throw new Error("Payment merchant does not match the configured account.");
    }
    _staxMerchantVerified = true;
}

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

async function staxRequest(apiKey: string, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: any }> {
    const res = await fetch(`${STAX_API_URL}${path}`, {
        ...init,
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...(init.headers || {}),
        },
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
}

serve(async (req) => {
    const ch = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: ch });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, ch);

    try {
        if (Deno.env.get("STAX_PAYMENTS_ENABLED") !== "true") {
            return json({ error: "Stax payments are not currently available." }, 503, ch);
        }
        // Parsed early so the sandbox-test gate below can read it. Body
        // shape is unchanged for every other caller.
        const body = await req.json().catch(() => ({}));
        const isProduction = (Deno.env.get("STAX_ENVIRONMENT") || "").toLowerCase() === "production";
        // ⚠️ Sandbox test path — mirrors the matching gate in
        // charge-stax-payment. This exists so the real Stax.js/embedded-
        // checkout flow can be click-tested against the sandbox merchant
        // before a production Stax account exists, without weakening the
        // real production gate for actual families. Requires BOTH signals:
        //   1. STAX_SANDBOX_TEST_ENABLED=true — a server secret, off by
        //      default, meant to be flipped on only while someone is
        //      actively testing and reverted immediately after.
        //   2. The request explicitly carries sandboxTest:true — sent only
        //      when the browser tab has ?staxtest=1 in its URL
        //      (pbStaxTestEnabled() in portal-billing.js).
        // Neither signal alone is enough: leaving the server secret on by
        // mistake does nothing to a real parent's normal "Pay online"
        // click, because that request never sets sandboxTest. A charge
        // made through this path still goes to Stax's real sandbox
        // merchant and is recorded exactly like any other Stax payment —
        // it is test money against a test merchant, not a fake success.
        const sandboxTestAllowed = Deno.env.get("STAX_SANDBOX_TEST_ENABLED") === "true" && body?.sandboxTest === true;
        if (!isProduction && !sandboxTestAllowed) {
            console.error("create-stax-charge: refusing parent payment outside production environment");
            return json({ error: "Online payments are not configured for production yet." }, 503, ch);
        }
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

        // ── 2. Input: an invoice id, nothing else ──────────────────
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

        const anchorMonth = String((invoice as any)?.billing_cycles?.month || "").slice(0, 7);
        const { data: quote, error: quoteErr } = await admin.rpc("stax_quote_balance", {
            p_invoice_id: invoice.id,
            p_family_id: invoice.family_id,
        });
        if (quoteErr) return json({ error: quoteErr.message }, 400, ch);
        const due = Number(quote?.amount);
        const priorBalance = Number(quote?.priorBalance) || 0;
        if (!Number.isFinite(due) || due <= 0) {
            return json({ error: "Could not calculate the current balance." }, 500, ch);
        }

        const { data: itemRows, error: itemErr } = await admin.rpc("compute_family_month_charges_itemized", {
            p_family_id: invoice.family_id, p_month: anchorMonth,
        });
        if (itemErr) return json({ error: "Could not calculate invoice details." }, 500, ch);
        const lineItems = (itemRows || []).map((r: any) => ({
            childName: String(r.child_name || "Child"),
            fullDays: Number(r.full_days) || 0,
            halfDays: Number(r.half_days) || 0,
            amount: Number(r.net) || 0,
        }));

        // ── 3. Resolve (or create) a Stax customer for this family ─
        const apiKey = Deno.env.get("STAX_API_KEY");
        if (!apiKey) return json({ error: "Payment processing is not configured yet." }, 500, ch);
        await assertStaxMerchant(apiKey);

        const { data: family, error: famErr } = await admin
            .from("families")
            .select("id, parent_name, parent_email, parent_phone, stax_customer_id, stax_default_payment_method_id, stax_default_card_last_four, stax_default_card_brand")
            .eq("id", invoice.family_id)
            .maybeSingle();
        if (famErr) return json({ error: famErr.message }, 500, ch);
        if (!family) return json({ error: "Family record not found." }, 404, ch);

        const nameParts = String(family.parent_name || "Family").trim().split(/\s+/);
        const firstname = nameParts[0] || "Family";
        const lastname = nameParts.slice(1).join(" ") || "MDO";

        let staxCustomerId: string | null = family.stax_customer_id || null;

        if (!staxCustomerId) {
            const created = await staxRequest(apiKey, "/customer", {
                method: "POST",
                body: JSON.stringify({
                    firstname, lastname,
                    email: family.parent_email || undefined,
                    reference: `mdo-family-${family.id}`,
                }),
            });
            if (!created.ok || !created.data?.id) {
                console.error("create-stax-charge: customer creation failed", created.status);
                return json({ error: "Could not start payment with Stax." }, 502, ch);
            }
            staxCustomerId = created.data.id;

            // Two tabs may both observe a missing customer. Only the first
            // conditional update wins; re-read and use the persisted winner
            // so the browser never tokenizes against an orphaned customer.
            const { error: saveCustomerErr } = await admin.from("families")
                .update({ stax_customer_id: staxCustomerId })
                .eq("id", family.id)
                .is("stax_customer_id", null);
            if (saveCustomerErr) return json({ error: "Could not save the payment customer." }, 500, ch);

            const { data: persistedFamily, error: persistedFamilyErr } = await admin.from("families")
                .select("stax_customer_id").eq("id", family.id).maybeSingle();
            if (persistedFamilyErr || !persistedFamily?.stax_customer_id) {
                return json({ error: "Could not confirm the payment customer." }, 500, ch);
            }
            staxCustomerId = persistedFamily.stax_customer_id;
        }

        // ── 4. Hand the browser what it needs to tokenize a card ───
        // Stax.js (Bolt) collects the card client-side and returns a
        // payment_method id; this server never sees the PAN. webPaymentsToken
        // is the client-safe token (NOT the server bearer key — see the ✅
        // note above); firstname/lastname/phone let the browser prefill
        // Stax.js's extraDetails without re-asking the parent for their own
        // name. A missing STAX_WEB_PAYMENTS_TOKEN is reported the same way a
        // missing STAX_API_KEY is — nothing partially works.
        const webPaymentsToken = Deno.env.get("STAX_WEB_PAYMENTS_TOKEN");
        if (!webPaymentsToken) return json({ error: "Payment processing is not configured yet." }, 500, ch);

        return json({
            customerId: staxCustomerId,
            webPaymentsToken,
            environment: isProduction ? "production" : "sandbox",
            amount: due,
            // The browser hides its installment control unless this exact
            // capability is present. That prevents a newer frontend from
            // sending a partial amount to an older charge function that
            // does not yet understand or enforce it.
            supportsPartialPayments: true,
            paymentAttemptId: crypto.randomUUID(),
            priorBalance,
            lineItems,
            invoiceId: invoice.id,
            firstname,
            lastname,
            phone: family.parent_phone || "",
            savedCard: family.stax_default_payment_method_id ? {
                last4: family.stax_default_card_last_four || "",
                brand: family.stax_default_card_brand || "",
            } : null,
        }, 200, ch);

    } catch (_err) {
        console.error("create-stax-charge: unhandled failure");
        return json({ error: "Could not start the payment session." }, 500, ch);
    }
});
