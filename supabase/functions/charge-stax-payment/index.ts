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
// ✅ /charge request/response shape verified live 2026-08-26, after the
//   Stax activations team turned on the sandbox gateway (see
//   create-stax-charge's header). Confirmed end to end against the real
//   sandbox: created a customer, vaulted a test Visa
//   (4111 1111 1111 1111) against it, then POSTed exactly the body this
//   file sends — {payment_method_id, customer_id, total, pre_auth, meta}
//   — to /charge and got back {"success": true, "id": "...", "status":
//   "SUCCESS", ...}. The `success`/`id` fields this code reads are
//   exactly right; no changes needed to the charge call itself.
//
//   5. A payment receipt email fires only on a genuinely NEW charge record
//      (the insert's own success, not the idempotent-duplicate path) — a
//      retried request that lands on the duplicate branch sends nothing a
//      second time. Same instinct and near-identical template as
//      authorizenet-webhook's sendReceiptEmail — same relationship, same
//      church, just the other processor. Kept as its own copy here rather
//      than a shared import: edge functions in this repo each deploy from
//      their own folder with no shared module path between them.
//
// ✅ /charge request/response shape verified live 2026-08-26 against the
//   real sandbox (see create-stax-charge's header). Embedded checkout
//   built the same session — see portal-billing.js (pbStartStaxPayment
//   onward). Still unverified in an actual browser (no
//   STAX_WEB_PAYMENTS_TOKEN available here — dashboard-only); see
//   CLAUDE.md's Stax section.
//
//   6. ⚠️ ROLLS UP OLDER UNPAID MONTHS (2026-08-27) and allocates the one
//      Stax charge across every invoice it covers, oldest first — see
//      computeFamilyDueSet(). Recomputed fresh here, not trusted from
//      whatever create-stax-charge quoted a moment earlier.
//   7. Saved card: pass useSavedCard:true instead of paymentMethodId to
//      charge the family's card on file (add_stax_saved_card.sql), or
//      saveCard:true after a fresh paymentMethodId to remember it for next
//      time. Only Stax's own payment_method_id plus last4/brand are ever
//      stored — never card data itself; see the migration's header.
//
// Deploy:  supabase functions deploy charge-stax-payment
// Secrets: STAX_API_KEY, RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_REPLY_TO
//          (shared with authorizenet-webhook / send-invoice)
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

function money(n: number): string { return "$" + (Number(n) || 0).toFixed(2); }

type DueRow = { id: number; due: number; month: string };

/** Same due-set builder as create-stax-charge's / create-payment-session's copy. */
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

function escHtml(s: string): string {
    return String(s ?? "").replace(/[&<>"']/g, c => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>
    )[c]);
}

function monthLabel(month: string): string {
    const m = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
    if (!m) return String(month || "");
    return new Date(Number(m[1]), Number(m[2]) - 1, 1)
        .toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/**
 * A payment receipt, sent only for a genuinely new charge (never a retry —
 * the caller only reaches here when the billing_payments insert itself
 * succeeded, not the idempotent-duplicate branch). Deliberately the same
 * branding as authorizenet-webhook's sendReceiptEmail — a family paying by
 * Stax should get the identical-looking receipt as one paying by
 * Authorize.net, not a Stax-branded one, since from the family's side this
 * is the same church, the same bill, just a different processor under the
 * hood they never need to know about.
 */
async function sendReceiptEmail(admin: any, o: {
    familyId: string; invoiceId: number; amountPaid: number; transId: string;
}): Promise<void> {
    const apiKey = Deno.env.get("RESEND_API_KEY");
    const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev";
    const replyTo = Deno.env.get("RESEND_REPLY_TO") || fromEmail;
    if (!apiKey) { console.warn("charge-stax-payment: RESEND_API_KEY not set, skipping receipt"); return; }

    const { data: fam } = await admin.from("families")
        .select("parent_name, parent_email").eq("id", o.familyId).maybeSingle();
    if (!fam?.parent_email) return;

    const { data: invoice } = await admin.from("billing_invoices")
        .select("final_amount, billing_cycles(month)")
        .eq("id", o.invoiceId).maybeSingle();
    const { data: paymentRows } = await admin.from("billing_payments")
        .select("amount").eq("invoice_id", o.invoiceId);
    const totalPaid = (paymentRows || []).reduce((s: number, p: { amount: number }) => s + (Number(p.amount) || 0), 0);
    const finalAmount = Number(invoice?.final_amount) || 0;
    const balanceRemaining = Math.max(0, finalAmount - totalPaid);
    const month = (invoice as any)?.billing_cycles?.month || "";

    // How many care days this invoice's month actually covers — same
    // family-matching logic as compute_family_month_charges, so it can
    // never disagree with the amount charged. 0 for a manually-priced
    // invoice with no real bookings (e.g. this Stax comparison's own test
    // invoices) — the line below is simply omitted in that case rather
    // than showing a confusing "0 days of care".
    const { data: daysOfCare } = await admin.rpc("count_family_month_care_days", {
        p_family_id: o.familyId, p_month: month,
    });

    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F0E4;font-family:'Nunito',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0E4;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(1,41,74,.08);">
        <tr>
          <td style="background:#C9E6DC;padding:26px 32px;border-bottom:3px solid #F5B731;text-align:center;">
            <p style="margin:0;color:#01294A;font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;">Timothy Lutheran Church</p>
            <h1 style="margin:6px 0 0;color:#01294A;font-size:22px;font-weight:800;">Mother's Day Out</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:30px 32px 8px;">
            <p style="margin:0 0 6px;color:#7A6E5A;font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;">Payment Receipt</p>
            <h2 style="margin:0 0 18px;color:#01294A;font-size:20px;font-weight:700;">${escHtml(monthLabel(month))}</h2>
            <p style="margin:0 0 18px;color:#2E2A22;font-size:15px;line-height:1.6;">
              Hello ${escHtml(fam.parent_name || "there")},<br>
              We've received your online payment. Thank you!
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 6px;">
              <tr>
                <td style="padding:9px 0;border-bottom:1px solid #F0EADA;color:#2E2A22;font-size:15px;">Amount paid</td>
                <td style="padding:9px 0;border-bottom:1px solid #F0EADA;color:#01294A;font-size:15px;text-align:right;font-weight:700;">${escHtml(money(o.amountPaid))}</td>
              </tr>
              ${Number(daysOfCare) > 0 ? `<tr>
                <td style="padding:9px 0;border-bottom:1px solid #F0EADA;color:#2E2A22;font-size:15px;">Days of care</td>
                <td style="padding:9px 0;border-bottom:1px solid #F0EADA;color:#01294A;font-size:15px;text-align:right;">${Number(daysOfCare)}</td>
              </tr>` : ""}
              <tr>
                <td style="padding:9px 0;border-bottom:1px solid #F0EADA;color:#2E2A22;font-size:15px;">Confirmation #</td>
                <td style="padding:9px 0;border-bottom:1px solid #F0EADA;color:#01294A;font-size:15px;text-align:right;">${escHtml(o.transId)}</td>
              </tr>
              <tr>
                <td style="padding:9px 0;color:#2E2A22;font-size:15px;">${balanceRemaining > 0 ? "Balance remaining" : "Status"}</td>
                <td style="padding:9px 0;color:#01294A;font-size:15px;text-align:right;font-weight:700;">${balanceRemaining > 0 ? escHtml(money(balanceRemaining)) : "Paid in full"}</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 32px 28px;">
            <p style="margin:0;color:#7A6E5A;font-size:14px;line-height:1.6;">
              If anything here looks wrong, just reply to this email and we'll take a look — it's no trouble at all.
            </p>
            <p style="margin:20px 0 0;color:#2E2A22;font-size:15px;">Thank you,<br>
              <strong style="color:#01294A;">Timothy Lutheran MDO</strong></p>
          </td>
        </tr>
        <tr>
          <td style="background:#FDFAF0;padding:16px 32px;text-align:center;border-top:1px solid #E8E0CC;">
            <p style="margin:0;color:#7A6E5A;font-size:12px;">You're receiving this because your child is enrolled at Timothy Lutheran Church MDO.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    try {
        await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                from: fromEmail,
                to: [String(fam.parent_email).trim()],
                reply_to: replyTo,
                subject: `Payment received — Timothy Lutheran MDO`,
                html,
            }),
        });
    } catch (e) {
        // A failed receipt email must never undo or fail the payment record
        // itself — the charge already happened and is already stored.
        console.error("charge-stax-payment: receipt email failed", e);
    }
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

        // ── 2. Input: an invoice id + either a fresh tokenized payment
        // method or "use the card already on file" ─────────────────────
        const body = await req.json().catch(() => ({}));
        const invoiceId = Number(body?.invoiceId);
        const bodyPaymentMethodId = String(body?.paymentMethodId || "");
        const useSavedCard = body?.useSavedCard === true;
        const saveCard = body?.saveCard === true;
        if (!Number.isFinite(invoiceId)) return json({ error: "invoiceId is required." }, 400, ch);
        if (!bodyPaymentMethodId && !useSavedCard) {
            return json({ error: "paymentMethodId is required." }, 400, ch);
        }

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
            .select("id, stax_customer_id, stax_default_payment_method_id")
            .eq("id", invoice.family_id)
            .maybeSingle();
        if (famErr) return json({ error: famErr.message }, 500, ch);
        if (!family?.stax_customer_id) {
            return json({ error: "Start a payment session before charging." }, 400, ch);
        }

        const paymentMethodId = useSavedCard ? (family.stax_default_payment_method_id || "") : bodyPaymentMethodId;
        if (!paymentMethodId) {
            return json({ error: useSavedCard ? "No saved card on file." : "paymentMethodId is required." }, 400, ch);
        }

        // ⚠️ Rolls up older unpaid months (2026-08-27) — same rule as
        // create-payment-session/create-stax-charge: charge the anchor
        // invoice's own balance plus any still-unpaid EARLIER month, never
        // a later one. Recomputed fresh here rather than trusting whatever
        // create-stax-charge quoted, since this is a separate request and
        // something could have changed in between.
        const anchorMonth = String((invoice as any)?.billing_cycles?.month || "").slice(0, 7);
        const dueSet = await computeFamilyDueSet(admin, String(invoice.family_id), anchorMonth);
        if (!dueSet.length) return json({ error: "This bill is already paid in full." }, 400, ch);
        const due = Math.round(dueSet.reduce((s, r) => s + r.due, 0) * 100) / 100;

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

        // ✅ success/id field names verified live 2026-08-26 — see header.
        const success = chargeRes.ok && chargeData?.success !== false && !!chargeData?.id;
        if (!success) {
            const msg = chargeData?.errors ? JSON.stringify(chargeData.errors) : "Payment was declined.";
            return json({ error: msg }, 502, ch);
        }

        const transactionId = String(chargeData.id);

        // ── 4. Allocate the one charge across every invoice it covers,
        // oldest first — idempotent per invoice via a suffixed transaction
        // id, same shape as authorizenet-webhook's allocateAcrossDueSet.
        let remaining = due;
        let anyNew = false;
        const touchedInvoiceIds: number[] = [];
        for (const row of dueSet) {
            if (remaining <= 0.004) break;
            const amt = Math.round(Math.min(remaining, row.due) * 100) / 100;
            if (amt <= 0.004) continue;

            const { error: insErr } = await admin.from("billing_payments").insert({
                family_id: invoice.family_id,
                invoice_id: row.id,
                amount: amt,
                payment_date: new Date().toISOString().slice(0, 10),
                payment_method: "card",
                note: `Stax online payment — invoice ${row.id}`,
                created_by: "charge-stax-payment",
                processor: "stax",
                processor_transaction_id: `${transactionId}-inv${row.id}`,
            });
            const isDuplicate = insErr && (String(insErr.code) === "23505" || /duplicate key/i.test(insErr.message || ""));
            if (insErr && !isDuplicate) {
                // The charge succeeded at Stax but we failed to record this
                // invoice's share — surface it loudly rather than silently
                // losing part of the payment. Invoices already recorded in
                // this loop stay recorded; a retry with the same
                // transactionId is idempotent per invoice either way.
                return json({ error: "Payment succeeded but could not be fully recorded. Contact the office.", partiallyRecorded: touchedInvoiceIds }, 500, ch);
            }
            if (!isDuplicate) anyNew = true;
            touchedInvoiceIds.push(row.id);
            remaining = Math.round((remaining - amt) * 100) / 100;

            const { data: payRows } = await admin.from("billing_payments").select("amount").eq("invoice_id", row.id);
            const totalPaid = (payRows || []).reduce((s: number, p: { amount: number }) => s + (Number(p.amount) || 0), 0);
            const { data: invRow } = await admin.from("billing_invoices").select("final_amount").eq("id", row.id).maybeSingle();
            const finalAmt = Number(invRow?.final_amount) || 0;
            const newStatus = totalPaid >= finalAmt && finalAmt > 0 ? "paid" : (totalPaid > 0 ? "partial" : "sent");
            await admin.from("billing_invoices").update({ status: newStatus }).eq("id", row.id);
        }

        // ── 5. Save the card for next time, if asked — only Stax's own
        // opaque payment_method_id plus the two PCI-permitted display
        // fields, read from Stax's own charge response. Best-effort: a
        // failed save never undoes or fails the payment, which already
        // happened.
        if (saveCard && !useSavedCard) {
            const cardInfo = chargeData?.payment_method || chargeData?.response?.payment_method || {};
            await admin.from("families").update({
                stax_default_payment_method_id: paymentMethodId,
                stax_default_card_last_four: cardInfo.card_last_four || cardInfo.last_four_digits || null,
                stax_default_card_brand: cardInfo.card_type || null,
            }).eq("id", invoice.family_id).then(() => {}, (e: unknown) => console.error("charge-stax-payment: save card failed", e));
        }

        // Receipt only on the genuinely-new insert(s) — a retry that lands
        // entirely on the duplicate branch must never send a second copy.
        if (anyNew) {
            try {
                await sendReceiptEmail(admin, {
                    familyId: String(invoice.family_id), invoiceId: invoice.id,
                    amountPaid: due, transId: transactionId,
                });
            } catch (e) {
                console.error("charge-stax-payment: receipt email failed", e);
            }
        }

        return json({ success: true, transactionId, amount: due, touchedInvoiceIds }, 200, ch);

    } catch (err) {
        return json({ error: (err as Error).message }, 500, ch);
    }
});
