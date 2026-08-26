// ============================================================
// create-stax-charge — starts a Stax (fattmerchant) payment
// ============================================================
// Scaffolding, not yet live-tested — see the ⚠️ block below. Mirrors
// create-payment-session's (Authorize.net) security posture exactly,
// because it is the same class of problem: a function that must never be
// aimable at an arbitrary amount or account.
//
//   1. The request body carries ONLY an invoice id. The amount charged is
//      always (final_amount - sum of recorded payments), computed here
//      from the database — never trusted from the caller.
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
// ⚠️ UNTESTED — Stax sandbox merchant not yet activated (2026-08-26).
//   `GET /merchant/{id}` for our sandbox merchant returns `gateways: []`,
//   `gateway_type: null`, `vendor_keys: null`, `activated_at: null` —
//   Stax's own Core API cannot vault a payment method until a gateway is
//   attached to the merchant record server-side. Confirmed live:
//   POST /payment-method (both card and ACH) fails with
//   {"errors":{"vaultLookup":["Failed to determine vault vendor for
//   merchant account"]}} regardless of request shape. Support was emailed
//   2026-08-26 re: merchant id 15904290-f3c8-4c6d-8d4d-fd2a953ce869. Do NOT
//   deploy this to production, and re-verify the customer-lookup/create
//   shape and the Stax.js public-key field name against
//   https://docs.staxpayments.com/reference once the merchant is active —
//   they were written from the Core API reference, not from a working
//   sandbox call.
//
// Deploy:  supabase functions deploy create-stax-charge
// Secrets: STAX_API_KEY, STAX_ENVIRONMENT ('sandbox' | 'production',
//          default sandbox)
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://mdo.timothystl.org";

// apiprod.fattlabs.com is Stax's single Core API host for both sandbox and
// production credentials — which environment you hit is determined by
// which API key you send, not by the URL (confirmed against the sandbox
// merchant check run this session). There is no separate sandbox host.
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
            .select("id, family_id, final_amount, status, sent_at")
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

        // ── 3. Resolve (or create) a Stax customer for this family ─
        const apiKey = Deno.env.get("STAX_API_KEY");
        if (!apiKey) return json({ error: "Payment processing is not configured yet." }, 500, ch);

        const { data: family, error: famErr } = await admin
            .from("families")
            .select("id, parent_name, parent_email, stax_customer_id")
            .eq("id", invoice.family_id)
            .maybeSingle();
        if (famErr) return json({ error: famErr.message }, 500, ch);
        if (!family) return json({ error: "Family record not found." }, 404, ch);

        let staxCustomerId: string | null = family.stax_customer_id || null;

        if (!staxCustomerId) {
            const nameParts = String(family.parent_name || "Family").trim().split(/\s+/);
            const firstname = nameParts[0] || "Family";
            const lastname = nameParts.slice(1).join(" ") || "MDO";
            const created = await staxRequest(apiKey, "/customer", {
                method: "POST",
                body: JSON.stringify({
                    firstname, lastname,
                    email: family.parent_email || undefined,
                    reference: `mdo-family-${family.id}`,
                }),
            });
            if (!created.ok || !created.data?.id) {
                return json({ error: created.data?.errors ? JSON.stringify(created.data.errors) : "Could not start payment with Stax." }, 502, ch);
            }
            staxCustomerId = created.data.id;

            // Best-effort — a failed save here just means we create a new
            // Stax customer next time rather than reusing this one. Never
            // block the payment attempt on it.
            await admin.from("families").update({ stax_customer_id: staxCustomerId }).eq("id", family.id);
        }

        // ── 4. Hand the browser what it needs to tokenize a card ───
        // Stax.js (Bolt) collects the card client-side and returns a
        // payment_method id; this server never sees the PAN. The public
        // key it needs is the SAME api key used here in most Stax
        // integrations — ⚠️ re-confirm this against Stax.js's own setup
        // docs once the sandbox is live; some Stax accounts issue a
        // separate publishable/tokenization key.
        return json({
            customerId: staxCustomerId,
            staxPublicKey: apiKey,
            environment: (Deno.env.get("STAX_ENVIRONMENT") || "sandbox").toLowerCase(),
            amount: due,
            invoiceId: invoice.id,
        }, 200, ch);

    } catch (err) {
        return json({ error: (err as Error).message }, 500, ch);
    }
});
