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
// ✅ Merchant activated 2026-08-26 (gateway_type: "TEST", gateways
//   non-empty) — Stax's activations team turned on the sandbox gateway
//   after support was emailed. The earlier `vaultLookup` block is gone.
//   The /customer create call in this file was verified live against the
//   real sandbox: POST /customer with {firstname, lastname, email,
//   reference} returns 200 with an `id` exactly as this code expects.
//
// ✅ Confirmed via Stax's own docs (2026-08-26): the browser needs a
//   SEPARATE "Website Payments Token" for Stax.js/Bolt — NOT the
//   STAX_API_KEY bearer key used server-side above. An earlier version of
//   this function returned the bearer key itself as `staxPublicKey`, which
//   would have handed our server-side secret to every browser that opened
//   the pay modal. Fixed: this now reads STAX_WEB_PAYMENTS_TOKEN, a
//   separate, client-safe secret (get it from the Stax dashboard —
//   Settings → Web Payments, per docs.staxpayments.com/docs/overview-of-staxjs).
//
// ✅ Embedded checkout built 2026-08-26 — see portal-billing.js
//   (pbStartStaxPayment onward) and portal.html's #pbStaxModal. Hidden
//   from every real family by default (?staxtest=1 only); see CLAUDE.md's
//   Stax section for what is and isn't verified in a real browser yet.
//
//   5. ⚠️ ROLLS UP OLDER UNPAID MONTHS (2026-08-27) — identical rule and
//      helper shape to create-payment-session's: paying invoice X charges
//      X's own balance plus any STILL-unpaid invoice for an earlier month,
//      never a later one. See computeFamilyDueSet().
//   6. Itemized via compute_family_month_charges_itemized() — same
//      per-child math compute_family_month_charges() already computes
//      internally; never a second copy of the rate/discount logic.
//   7. Saved-card lookup: if this family already has a saved Stax payment
//      method (add_stax_saved_card.sql), this returns its last4/brand so
//      the browser can offer "pay with the card on file" and skip card
//      entry entirely — charge-stax-payment does the actual charge either
//      way. Nothing here ever sees the card itself, saved or new; only
//      Stax's own opaque payment_method_id and the two PCI-permitted
//      display fields (last4, brand) are stored.
//
// Deploy:  supabase functions deploy create-stax-charge
// Secrets: STAX_API_KEY, STAX_WEB_PAYMENTS_TOKEN, STAX_ENVIRONMENT
//          ('sandbox' | 'production', default sandbox)
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

type DueRow = { id: number; due: number; month: string };

/** Same due-set builder as create-payment-session's copy — see its header. */
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

        const anchorMonth = String((invoice as any)?.billing_cycles?.month || "").slice(0, 7);

        const dueSet = await computeFamilyDueSet(admin, String(invoice.family_id), anchorMonth);
        if (!dueSet.length) return json({ error: "This bill is already paid in full." }, 400, ch);
        const due = Math.round(dueSet.reduce((s, r) => s + r.due, 0) * 100) / 100;
        const priorBalance = Math.round(
            dueSet.filter(r => r.month < anchorMonth).reduce((s, r) => s + r.due, 0) * 100,
        ) / 100;

        const { data: itemRows } = await admin.rpc("compute_family_month_charges_itemized", {
            p_family_id: invoice.family_id, p_month: anchorMonth,
        });
        const lineItems = (itemRows || []).map((r: any) => ({
            childName: String(r.child_name || "Child"),
            fullDays: Number(r.full_days) || 0,
            halfDays: Number(r.half_days) || 0,
            amount: Number(r.net) || 0,
        }));

        // ── 3. Resolve (or create) a Stax customer for this family ─
        const apiKey = Deno.env.get("STAX_API_KEY");
        if (!apiKey) return json({ error: "Payment processing is not configured yet." }, 500, ch);

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
            environment: (Deno.env.get("STAX_ENVIRONMENT") || "sandbox").toLowerCase(),
            amount: due,
            priorBalance,
            lineItems,
            invoiceId: invoice.id,
            firstname,
            lastname,
            phone: family.parent_phone || "",
            savedCard: family.stax_default_payment_method_id ? {
                paymentMethodId: family.stax_default_payment_method_id,
                last4: family.stax_default_card_last_four || "",
                brand: family.stax_default_card_brand || "",
            } : null,
        }, 200, ch);

    } catch (err) {
        return json({ error: (err as Error).message }, 500, ch);
    }
});
