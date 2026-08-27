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
//      id. The caller may request an installment amount, but the live
//      outstanding balance is recomputed here and the request is rejected
//      unless it is positive, cent-precise, and no greater than that balance.
//      Omitting an amount charges the full balance for older clients.
//   2. Same ownership/status checks as create-stax-charge: caller must
//      hold a parent session, the invoice must belong to their own
//      family, and it must be issued (sent_at set, status sent/partial).
//   3. A stable paymentAttemptId from create-stax-charge is used both for
//      the family-wide database reservation and Stax's idempotency_id.
//      Retrying the same request therefore returns/finalizes the original
//      attempt instead of creating another processor charge.
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
//   6. Rolls up older unpaid months and allocates a successful charge in
//      one restricted Postgres transaction. If the due set changes while
//      Stax is processing, any excess becomes an explicit unapplied credit.
//   7. Saved card: pass useSavedCard:true instead of paymentMethodId to
//      charge the family's card on file (add_stax_saved_card.sql), or
//      saveCard:true after a fresh paymentMethodId to remember it for next
//      time. Only Stax's own payment_method_id plus last4/brand are ever
//      stored — never card data itself; see the migration's header.
//   8. CHARGE-LOCKED against double-charging. The active lock is unique per
//      FAMILY, since different anchor invoices can cover overlapping debt.
//      A network error or a Stax PENDING status is treated as ambiguous and
//      leaves the lock 'pending' on purpose (never releases it for a
//      retry); only a clean decline releases it. The idempotency_id sent to
//      Stax is the second, independent layer: a genuine network-level retry
//      of the identical request returns Stax's ORIGINAL transaction rather
//      than creating a new one.
//
// Deploy:  supabase functions deploy charge-stax-payment
// Secrets: STAX_API_KEY, STAX_PAYMENTS_ENABLED, RESEND_API_KEY,
//          RESEND_FROM_EMAIL, RESEND_REPLY_TO
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
        status, headers: { ...ch, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
}

/** Stax wants a decimal dollar amount, same shape as Authorize.net's. */
function amountStr(n: number): string {
    return (Math.round(n * 100) / 100).toFixed(2);
}

function money(n: number): string { return "$" + (Number(n) || 0).toFixed(2); }

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
    familyId: string; invoiceId: number; amountPaid: number;
    balanceRemaining: number; transId: string;
}): Promise<void> {
    const apiKey = Deno.env.get("RESEND_API_KEY");
    const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev";
    const replyTo = Deno.env.get("RESEND_REPLY_TO") || fromEmail;
    if (!apiKey) { console.warn("charge-stax-payment: RESEND_API_KEY not set, skipping receipt"); return; }

    const { data: fam } = await admin.from("families")
        .select("parent_name, parent_email").eq("id", o.familyId).maybeSingle();
    if (!fam?.parent_email) return;

    const { data: invoice } = await admin.from("billing_invoices")
        .select("billing_cycles(month)")
        .eq("id", o.invoiceId).maybeSingle();
    const balanceRemaining = Math.max(0, o.balanceRemaining);
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
                <td style="padding:9px 0;color:#2E2A22;font-size:15px;">${balanceRemaining > 0 ? "Account balance remaining" : "Status"}</td>
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
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, ch);

    try {
        if (Deno.env.get("STAX_PAYMENTS_ENABLED") !== "true") {
            return json({ error: "Stax payments are not currently available." }, 503, ch);
        }
        if ((Deno.env.get("STAX_ENVIRONMENT") || "").toLowerCase() !== "production") {
            console.error("charge-stax-payment: refusing parent payment outside production environment");
            return json({ error: "Online payments are not configured for production yet." }, 503, ch);
        }
        const apiKey = Deno.env.get("STAX_API_KEY");
        if (!apiKey) return json({ error: "Payment processing is not configured yet." }, 500, ch);

        // ── 1. Authenticate the parent and resolve their families ──────
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

        // ── 2. Validate non-card input. Raw PAN/CVV never reaches here. ─
        const body = await req.json().catch(() => ({}));
        const invoiceId = Number(body?.invoiceId);
        const paymentAttemptId = String(body?.paymentAttemptId || "").toLowerCase();
        const bodyPaymentMethodId = String(body?.paymentMethodId || "");
        const useSavedCard = body?.useSavedCard === true;
        const saveCard = body?.saveCard === true;
        const requestedAmount = body?.amount;
        if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) {
            return json({ error: "A valid invoiceId is required." }, 400, ch);
        }
        if (!paymentAttemptId) return json({ error: "paymentAttemptId is required." }, 400, ch);
        if (requestedAmount != null && (typeof requestedAmount !== "number" || !Number.isFinite(requestedAmount))) {
            return json({ error: "Payment amount must be a number." }, 400, ch);
        }
        if (!bodyPaymentMethodId && !useSavedCard) {
            return json({ error: "paymentMethodId is required." }, 400, ch);
        }

        const admin = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );
        const { data: invoice, error: invErr } = await admin
            .from("billing_invoices")
            .select("id, family_id, status, sent_at, billing_cycles(month)")
            .eq("id", invoiceId)
            .maybeSingle();
        if (invErr) return json({ error: "Could not load the invoice." }, 500, ch);
        if (!invoice) return json({ error: "Invoice not found." }, 404, ch);
        if (!myFamilyIds.has(String(invoice.family_id))) {
            return json({ error: "That invoice does not belong to your family." }, 403, ch);
        }
        if (!invoice.sent_at || !["sent", "partial"].includes(invoice.status)) {
            return json({ error: "This bill has not been issued or is no longer payable." }, 400, ch);
        }

        const { data: family, error: famErr } = await admin
            .from("families")
            .select("id, stax_customer_id, stax_default_payment_method_id")
            .eq("id", invoice.family_id)
            .maybeSingle();
        if (famErr) return json({ error: "Could not load the payment customer." }, 500, ch);
        if (!family?.stax_customer_id) {
            return json({ error: "Start a payment session before charging." }, 400, ch);
        }
        const paymentMethodId = useSavedCard ? (family.stax_default_payment_method_id || "") : bodyPaymentMethodId;
        if (!paymentMethodId) {
            return json({ error: useSavedCard ? "No saved card on file." : "paymentMethodId is required." }, 400, ch);
        }
        if (paymentMethodId.length > 200) return json({ error: "Invalid payment method." }, 400, ch);

        // Never trust an opaque token merely because the browser supplied it.
        // Verify through Stax that it is actually attached to this family's
        // customer before reserving or charging anything.
        let methodRes: Response;
        let methodBody: any = {};
        try {
            methodRes = await fetch(`${STAX_API_URL}/payment-method/${encodeURIComponent(paymentMethodId)}`, {
                headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
            });
            methodBody = await methodRes.json().catch(() => ({}));
        } catch (_err) {
            return json({ error: "Could not verify the payment method. Please try again." }, 502, ch);
        }
        const verifiedMethod = methodBody?.data && typeof methodBody.data === "object" ? methodBody.data : methodBody;
        if (!methodRes.ok || String(verifiedMethod?.id || "") !== paymentMethodId
            || String(verifiedMethod?.customer_id || "") !== family.stax_customer_id) {
            return json({ error: "That payment method is not available for this family." }, 400, ch);
        }

        // ── 3. Atomically price and reserve the whole family balance. ───
        const { data: prepared, error: prepareErr } = await admin.rpc("stax_prepare_charge", {
            p_invoice_id: invoice.id,
            p_family_id: invoice.family_id,
            p_requested_amount: requestedAmount ?? null,
            p_idempotency_key: paymentAttemptId,
        });
        if (prepareErr) {
            const busy = String(prepareErr.code) === "55P03" || /already being processed/i.test(prepareErr.message || "");
            return json({ error: busy
                ? "A payment for this family is already being processed. Please wait and check your balance before trying again."
                : prepareErr.message }, busy ? 409 : 400, ch);
        }

        const lockId = Number(prepared?.lockId);
        const chargeAmount = Number(prepared?.amount);
        if (!Number.isSafeInteger(lockId) || !Number.isFinite(chargeAmount) || chargeAmount <= 0) {
            return json({ error: "Could not reserve this payment." }, 500, ch);
        }

        // A response may have been lost after the processor or database
        // succeeded. Reusing the same attempt id completes/returns that same
        // attempt; it never calls Stax again.
        if (prepared?.existing === true) {
            if (prepared.status === "succeeded") {
                return json({ success: true, alreadyProcessed: true,
                    transactionId: prepared.transactionId, amount: chargeAmount }, 200, ch);
            }
            if (prepared.status === "processor_succeeded") {
                const { data: recovered, error: recoverErr } = await admin.rpc("stax_finalize_charge", { p_lock_id: lockId });
                if (recoverErr) return json({ error: "Payment succeeded but still needs office reconciliation." }, 500, ch);
                return json(recovered, 200, ch);
            }
            return json({ error: "This payment attempt is already processing. Please wait and check your balance before trying again.", ambiguous: prepared.status === "ambiguous" }, 409, ch);
        }

        const setState = async (status: "ambiguous" | "processor_succeeded" | "failed", transactionId?: string, note?: string) => {
            const { error } = await admin.rpc("stax_set_charge_state", {
                p_lock_id: lockId,
                p_status: status,
                p_transaction_id: transactionId || null,
                p_note: note || null,
            });
            if (error) console.error("charge-stax-payment: could not persist processor state", error.code);
            return !error;
        };

        // ── 4. Move money using the same stable idempotency key. ────────
        const month = String((invoice as any)?.billing_cycles?.month || "");
        let chargeRes: Response;
        let chargeData: any = {};
        try {
            chargeRes = await fetch(`${STAX_API_URL}/charge`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    payment_method_id: paymentMethodId,
                    customer_id: family.stax_customer_id,
                    total: amountStr(chargeAmount),
                    pre_auth: false,
                    idempotency_id: paymentAttemptId,
                    meta: {
                        memo: `Timothy Lutheran MDO — ${month} — invoice ${invoice.id}`,
                        reference: `mdoinv-${invoice.id}`,
                        payment_attempt_id: paymentAttemptId,
                    },
                }),
            });
            chargeData = await chargeRes.json().catch(() => ({}));
        } catch (_err) {
            await setState("ambiguous", undefined, "Network failure while awaiting Stax response");
            return json({ error: "We couldn't confirm whether your payment went through. Please wait and contact the office before trying again.", ambiguous: true }, 502, ch);
        }

        const staxStatus = String(chargeData?.status || "").toUpperCase();
        const transactionId = String(chargeData?.id || "");
        if (staxStatus === "PENDING") {
            await setState("ambiguous", transactionId || undefined, "Stax returned PENDING");
            return json({ error: "Your payment is still processing at the card network. Please wait before trying again.", ambiguous: true }, 202, ch);
        }

        const strictSuccess = chargeRes.ok
            && chargeData?.success === true
            && staxStatus === "SUCCESS"
            && !!transactionId;
        if (!strictSuccess) {
            const definitiveFailure = chargeData?.success === false || ["FAILED", "DECLINED"].includes(staxStatus);
            if (definitiveFailure) {
                await setState("failed", transactionId || undefined, "Stax declined the charge");
                return json({ error: "Payment was declined.", nextPaymentAttemptId: crypto.randomUUID() }, 402, ch);
            }
            await setState("ambiguous", transactionId || undefined, "Unrecognized Stax response state");
            return json({ error: "We couldn't safely determine the payment result. Please contact the office before retrying.", ambiguous: true }, 502, ch);
        }

        const returnedTotal = Number(chargeData?.total);
        const returnedCustomer = String(chargeData?.customer_id || "");
        if (!Number.isFinite(returnedTotal)
            || Math.round(returnedTotal * 100) !== Math.round(chargeAmount * 100)
            || returnedCustomer !== family.stax_customer_id) {
            await setState("ambiguous", transactionId, "Stax success response did not match reserved amount/customer");
            return json({ error: "The processor response did not match this payment. The office must reconcile it before another attempt.", ambiguous: true }, 502, ch);
        }

        const stateSaved = await setState("processor_succeeded", transactionId);
        if (!stateSaved) {
            return json({ error: "Payment succeeded but could not be recorded. Contact the office; do not retry.", ambiguous: true }, 500, ch);
        }

        // ── 5. One transaction records every allocation and status. ────
        const { data: finalized, error: finalizeErr } = await admin.rpc("stax_finalize_charge", { p_lock_id: lockId });
        if (finalizeErr) {
            console.error("charge-stax-payment: atomic finalization failed", finalizeErr.code);
            return json({ error: "Payment succeeded but could not be recorded. Contact the office; do not retry.", ambiguous: true }, 500, ch);
        }

        // Save only an opaque token and display metadata, and only after the
        // successful family-bound charge has been durably recorded.
        if (saveCard && !useSavedCard) {
            const cardInfo = chargeData?.payment_method || chargeData?.response?.payment_method || {};
            const rawLast4 = String(cardInfo?.card_last_four || cardInfo?.last_four_digits || "");
            const last4 = /^[0-9]{4}$/.test(rawLast4) ? rawLast4 : null;
            const brand = cardInfo?.card_type ? String(cardInfo.card_type).slice(0, 40) : null;
            const { error: saveErr } = await admin.from("families").update({
                stax_default_payment_method_id: paymentMethodId,
                stax_default_card_last_four: last4,
                stax_default_card_brand: brand,
            }).eq("id", invoice.family_id).eq("stax_customer_id", family.stax_customer_id);
            if (saveErr) console.error("charge-stax-payment: saved-card metadata update failed", saveErr.code);
        }

        if (finalized?.anyNew === true) {
            try {
                await sendReceiptEmail(admin, {
                    familyId: String(invoice.family_id), invoiceId: invoice.id,
                    amountPaid: Number(finalized.amount) || chargeAmount,
                    balanceRemaining: Number(finalized.balanceRemaining) || 0,
                    transId: transactionId,
                });
            } catch (_err) {
                console.error("charge-stax-payment: receipt email failed");
            }
        }

        return json(finalized, 200, ch);
    } catch (_err) {
        console.error("charge-stax-payment: unhandled failure");
        return json({ error: "Payment processing failed safely. Please try again or contact the office." }, 500, ch);
    }
});
