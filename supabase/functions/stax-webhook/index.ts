// ============================================================
// stax-webhook — verified, atomic Stax transaction recording
// ============================================================
// Stax does not sign webhook payloads. Its supported shared-secret pattern
// puts a merchant-chosen secret in the registered target URL, which can be
// exposed in proxy/access logs. The URL secret is therefore only the first
// check: before changing the database, this function fetches the transaction
// by id from Stax's authenticated Core API and uses ONLY that response's
// type, parent transaction, status, customer, and amount.
//
// Refund/void allocation is performed by service-role-only
// stax_record_reversal() in one Postgres transaction. Ordinary successful
// charge events can recover a synchronous charge whose browser/edge request
// lost its response, using the same stable payment attempt id.
//
// Deploy without gateway JWT verification: Stax is the caller. Set
// STAX_WEBHOOK_SECRET and STAX_API_KEY. Register create_transaction with:
//   <function-url>?secret=<STAX_WEBHOOK_SECRET>
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { safeEqual } from "../_shared/timing-safe.ts";
import { extractStaxPaymentFields } from "../_shared/stax-transaction-fields.ts";
import { json as jsonResponse } from "../_shared/http.ts";
import { escHtml } from "../_shared/html.ts";

const STAX_API_URL = "https://apiprod.fattlabs.com";

function json(body: unknown, status: number) {
    return jsonResponse(body, status, { "Cache-Control": "no-store" });
}

function cents(value: unknown): number | null {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    const rounded = Math.round(n * 100);
    return Math.abs(n * 100 - rounded) <= 0.000001 ? rounded : null;
}

function money(n: number): string { return "$" + (Number(n) || 0).toFixed(2); }

/**
 * Same receipt as charge-stax-payment's sendReceiptEmail — kept as its own
 * copy per this repo's edge-function convention (no shared import path
 * between functions; see charge-stax-payment's own header comment). This
 * copy exists because a charge confirmed here (the browser lost the
 * synchronous response, and Stax's own webhook told us it actually
 * succeeded) is just as real a charge as one confirmed synchronously — a
 * family charged through this recovery path deserves the identical receipt,
 * not silence. Before this, stax-webhook recorded the payment but never
 * emailed anyone.
 */
async function sendReceiptEmail(admin: any, o: {
    familyId: string; invoiceId: number; amountPaid: number;
    balanceRemaining: number; transId: string;
    cardBrand?: string | null; cardLast4?: string | null;
}): Promise<void> {
    const apiKey = Deno.env.get("RESEND_API_KEY");
    const fromEmail = `"Timothy MDO Billing" <${Deno.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev"}>`;
    if (!apiKey) { console.warn("stax-webhook: RESEND_API_KEY not set, skipping receipt"); return; }

    const { data: fam } = await admin.from("families")
        .select("parent_name, parent_email, parent2_email").eq("id", o.familyId).maybeSingle();
    if (!fam?.parent_email) return;

    const seenEmails = new Map<string, string>();
    for (const e of [fam.parent_email, fam.parent2_email]) {
        const trimmed = typeof e === "string" ? e.trim() : "";
        if (trimmed && !seenEmails.has(trimmed.toLowerCase())) seenEmails.set(trimmed.toLowerCase(), trimmed);
    }
    const toEmails = [...seenEmails.values()];

    const { data: invoice } = await admin.from("billing_invoices")
        .select("billing_cycles(month)")
        .eq("id", o.invoiceId).maybeSingle();
    const balanceRemaining = Math.max(0, o.balanceRemaining);
    const anchorMonth = (invoice as any)?.billing_cycles?.month || "";

    const { data: paymentRows } = await admin.from("billing_payments")
        .select("amount, invoice_id, billing_invoices(billing_cycles(month))")
        .eq("processor", "stax")
        .or(`processor_transaction_id.eq.${o.transId},processor_transaction_id.like.${o.transId}-inv%`);
    let currentMonthAmount = 0, priorBalanceAmount = 0;
    for (const row of (paymentRows || []) as any[]) {
        const rowMonth = row?.billing_invoices?.billing_cycles?.month || "";
        if (rowMonth && anchorMonth && rowMonth === anchorMonth) currentMonthAmount += Number(row.amount) || 0;
        else priorBalanceAmount += Number(row.amount) || 0;
    }
    const totalPaid = (currentMonthAmount + priorBalanceAmount) > 0
        ? currentMonthAmount + priorBalanceAmount : Number(o.amountPaid) || 0;

    const invoiceNumber = `INV-${o.invoiceId}`;
    const paidOn = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const paymentMethodLine = o.cardLast4
        ? `${escHtml(o.cardBrand || "Card")} &middot;&middot;&middot;&middot;${escHtml(o.cardLast4)}` : null;

    const html = buildReceiptHtml({
        familyName: fam.parent_name || "there",
        invoiceNumber, paidOn, paymentMethodLine,
        confirmationNumber: o.transId,
        totalPaid, currentMonthAmount, priorBalanceAmount,
        balanceRemaining,
    });

    try {
        const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                from: fromEmail,
                to: toEmails,
                subject: `Payment received — Timothy Lutheran MDO`,
                html,
            }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            console.error("stax-webhook: receipt email rejected by Resend", res.status, body);
        }
    } catch (e) {
        console.error("stax-webhook: receipt email failed", e);
    }
}

/** Identical markup to charge-stax-payment's buildReceiptHtml. */
function buildReceiptHtml(o: {
    familyName: string; invoiceNumber: string; paidOn: string;
    paymentMethodLine: string | null; confirmationNumber: string;
    totalPaid: number; currentMonthAmount: number; priorBalanceAmount: number;
    balanceRemaining: number;
}): string {
    const showBreakdown = o.priorBalanceAmount > 0.005 && o.currentMonthAmount > 0.005;
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F0E4;font-family:'Nunito',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0E4;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(1,41,74,.08);">
        <tr>
          <td style="background:#01294A;padding:28px 32px;text-align:center;">
            <img src="https://mdo.timothystl.org/images/logo/brand-wordmark-on-dark.png"
                 alt="my MDO" width="120" height="auto" style="display:block;margin:0 auto 10px;">
            <p style="margin:0;color:#F5B731;font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;">Timothy Lutheran Church</p>
            <p style="margin:4px 0 0;color:rgba(255,255,255,.75);font-size:13px;">Mother's Day Out</p>
          </td>
        </tr>
        <tr>
          <td style="padding:34px 32px 8px;text-align:center;">
            <img src="https://mdo.timothystl.org/images/illustrations/payment-received.png"
                 alt="" width="180" height="135"
                 style="display:block;margin:0 auto 10px;width:180px;height:auto;">
            <h1 style="margin:0 0 4px;color:#01294A;font-size:22px;font-weight:800;font-family:Georgia,'Times New Roman',serif;">Payment received</h1>
            <p style="margin:0 0 18px;color:#7A6E5A;font-size:14px;">Thank you, ${escHtml(o.familyName)}.</p>
            <p style="margin:0 0 26px;color:#01294A;font-size:34px;font-weight:800;font-family:Georgia,'Times New Roman',serif;">${escHtml(money(o.totalPaid))}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E8E0CC;border-radius:10px;">
              <tr>
                <td style="padding:12px 16px;border-bottom:1px solid #F0EADA;color:#7A6E5A;font-size:14px;">Invoice</td>
                <td style="padding:12px 16px;border-bottom:1px solid #F0EADA;color:#01294A;font-size:14px;text-align:right;font-weight:700;">${escHtml(o.invoiceNumber)}</td>
              </tr>
              <tr>
                <td style="padding:12px 16px;${o.paymentMethodLine ? 'border-bottom:1px solid #F0EADA;' : ''}color:#7A6E5A;font-size:14px;">Paid on</td>
                <td style="padding:12px 16px;${o.paymentMethodLine ? 'border-bottom:1px solid #F0EADA;' : ''}color:#01294A;font-size:14px;text-align:right;font-weight:700;">${escHtml(o.paidOn)}</td>
              </tr>
              ${o.paymentMethodLine ? `<tr>
                <td style="padding:12px 16px;border-bottom:1px solid #F0EADA;color:#7A6E5A;font-size:14px;">Payment method</td>
                <td style="padding:12px 16px;border-bottom:1px solid #F0EADA;color:#01294A;font-size:14px;text-align:right;font-weight:700;">${o.paymentMethodLine}</td>
              </tr>` : ""}
              <tr>
                <td style="padding:12px 16px;color:#7A6E5A;font-size:14px;">Confirmation #</td>
                <td style="padding:12px 16px;color:#01294A;font-size:14px;text-align:right;font-weight:700;">${escHtml(o.confirmationNumber)}</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 8px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              ${showBreakdown ? `<tr>
                <td style="padding:5px 0;color:#7A6E5A;font-size:14px;">Current month charges</td>
                <td style="padding:5px 0;color:#01294A;font-size:14px;text-align:right;">${escHtml(money(o.currentMonthAmount))}</td>
              </tr>
              <tr>
                <td style="padding:5px 0 12px;border-bottom:1px dashed #E8E0CC;color:#7A2A18;font-size:14px;">Prior balance</td>
                <td style="padding:5px 0 12px;border-bottom:1px dashed #E8E0CC;color:#7A2A18;font-size:14px;text-align:right;">${escHtml(money(o.priorBalanceAmount))}</td>
              </tr>` : ""}
              <tr>
                <td style="padding:${showBreakdown ? '12px' : '0'} 0 0;color:#01294A;font-size:15px;font-weight:800;">Total paid</td>
                <td style="padding:${showBreakdown ? '12px' : '0'} 0 0;color:#01294A;font-size:15px;font-weight:800;text-align:right;">${escHtml(money(o.totalPaid))}</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:22px 32px 30px;text-align:center;">
            <a href="https://mdo.timothystl.org/parent.html"
               style="display:inline-block;background:#01294A;color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:13px 28px;border-radius:8px;">View billing account</a>
          </td>
        </tr>
        <tr>
          <td style="background:#FDFAF0;padding:18px 32px;text-align:center;border-top:1px solid #E8E0CC;">
            <p style="margin:0 0 6px;color:#7A6E5A;font-size:13px;">Questions about this charge? Contact the front office at (314) 781-8673 or at mdo@timothystl.org.</p>
            <p style="margin:0;color:#B5AB90;font-size:11px;">This is a receipt for a payment you made and does not accept replies.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

serve(async (req) => {
    if (req.method === "GET" || req.method === "HEAD") return json({ ok: true }, 200);
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const secret = Deno.env.get("STAX_WEBHOOK_SECRET");
    const apiKey = Deno.env.get("STAX_API_KEY");
    if (!secret || !apiKey) return json({ error: "Webhook is not configured" }, 503);

    const suppliedSecret = new URL(req.url).searchParams.get("secret") || "";
    if (!(await safeEqual(suppliedSecret, secret))) return json({ error: "Unauthorized" }, 401);

    const contentLength = Number(req.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > 65536) {
        return json({ error: "Payload too large" }, 413);
    }

    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Bad payload" }, 400); }
    const eventTransactionId = String(body?.id || "");
    if (!eventTransactionId || eventTransactionId.length > 200) {
        return json({ error: "Missing transaction id" }, 400);
    }

    // The webhook body is only a notification. Retrieve the authoritative
    // transaction with a server-held credential before trusting any field.
    let verifyRes: Response;
    let verifyBody: any = {};
    try {
        verifyRes = await fetch(`${STAX_API_URL}/transaction/${encodeURIComponent(eventTransactionId)}`, {
            headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
        });
        verifyBody = await verifyRes.json().catch(() => ({}));
    } catch (_err) {
        return json({ error: "Could not verify transaction" }, 502);
    }
    if (!verifyRes.ok) return json({ error: "Could not verify transaction" }, 502);

    const transaction = verifyBody?.data && typeof verifyBody.data === "object"
        ? verifyBody.data
        : verifyBody;
    if (String(transaction?.id || "") !== eventTransactionId) {
        return json({ error: "Verified transaction id mismatch" }, 409);
    }

    const kind = String(transaction?.type || "").toLowerCase();
    const status = String(transaction?.status || "").toUpperCase();
    // The transaction lookup response documents `success`; some transaction
    // shapes also include `status`. If status is present, require it to agree.
    const verifiedSuccess = transaction?.success === true && (!status || status === "SUCCESS");
    const amountCents = cents(transaction?.total);
    const admin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (kind === "charge") {
        // Recover ambiguous/synchronous attempts when Stax confirms the
        // charge asynchronously. Unrelated dashboard charges are ignored.
        if (!verifiedSuccess || amountCents === null) {
            return json({ received: true, ignored: "charge not successful" }, 200);
        }
        const attemptId = String(
            transaction?.idempotency_id
            || transaction?.meta?.payment_attempt_id
            || transaction?.meta?.paymentAttemptId
            || "",
        ).toLowerCase();
        if (!attemptId) return json({ received: true, ignored: "charge has no app attempt id" }, 200);

        const { data: lock, error: lockErr } = await admin.from("payment_charge_locks")
            .select("id, invoice_id, family_id, charge_amount, status")
            .eq("processor", "stax")
            .eq("idempotency_key", attemptId)
            .maybeSingle();
        if (lockErr) return json({ error: "Could not load payment attempt" }, 500);
        if (!lock) return json({ received: true, ignored: "unknown app attempt" }, 200);
        if (Math.round(Number(lock.charge_amount) * 100) !== amountCents) {
            return json({ error: "Verified charge amount does not match reserved attempt" }, 409);
        }
        const { data: family, error: familyErr } = await admin.from("families")
            .select("stax_customer_id").eq("id", lock.family_id).maybeSingle();
        if (familyErr) return json({ error: "Could not load payment customer" }, 500);
        if (!family || String(transaction?.customer_id || "") !== String(family.stax_customer_id || "")) {
            return json({ error: "Verified charge customer does not match reserved attempt" }, 409);
        }

        const staxFields = extractStaxPaymentFields(transaction);
        const { error: stateErr } = await admin.rpc("stax_set_charge_state", {
            p_lock_id: lock.id,
            p_status: "processor_succeeded",
            p_transaction_id: eventTransactionId,
            p_note: "Recovered/confirmed by verified Stax webhook",
            p_processor_fee: staxFields.processorFee,
            p_payment_method: staxFields.paymentMethod,
        });
        if (stateErr) return json({ error: "Could not record processor success" }, 500);
        const { data: finalized, error: finalizeErr } = await admin.rpc("stax_finalize_charge", {
            p_lock_id: lock.id,
        });
        if (finalizeErr) return json({ error: "Could not finalize verified charge" }, 500);

        // A charge recovered here is just as real as one confirmed
        // synchronously in charge-stax-payment — same anyNew gate (never a
        // retry/duplicate), same receipt. Before this, a charge confirmed
        // only through this async path never emailed anyone at all.
        if (finalized?.anyNew === true) {
            try {
                const cardInfo = transaction?.payment_method || transaction?.response?.payment_method || {};
                const rawLast4 = String(cardInfo?.card_last_four || cardInfo?.last_four_digits || "");
                const last4 = /^[0-9]{4}$/.test(rawLast4) ? rawLast4 : null;
                const brand = cardInfo?.card_type ? String(cardInfo.card_type).slice(0, 40) : null;
                await sendReceiptEmail(admin, {
                    familyId: String(lock.family_id), invoiceId: Number(lock.invoice_id),
                    amountPaid: Number(finalized.amount) || amountCents / 100,
                    balanceRemaining: Number(finalized.balanceRemaining) || 0,
                    transId: eventTransactionId,
                    cardBrand: brand, cardLast4: last4,
                });
            } catch (_err) {
                console.error("stax-webhook: receipt email failed");
            }
        }

        return json({ received: true, recoveredCharge: true, finalized }, 200);
    }

    if (kind !== "refund" && kind !== "void") {
        return json({ received: true, ignored: kind || "unsupported transaction type" }, 200);
    }
    if (!verifiedSuccess) {
        return json({ received: true, ignored: `${kind} not successful` }, 200);
    }

    const parentTransactionId = String(transaction?.reference_id || "");
    if (!parentTransactionId || amountCents === null) {
        return json({ error: "Verified reversal is incomplete" }, 409);
    }

    const { data: result, error: reversalErr } = await admin.rpc("stax_record_reversal", {
        p_event_id: eventTransactionId,
        p_parent_transaction_id: parentTransactionId,
        p_kind: kind,
        p_amount: amountCents / 100,
    });
    if (reversalErr) {
        const retryable = String(reversalErr.code) === "P0002";
        return json({ error: reversalErr.message }, retryable ? 409 : 500);
    }
    return json(result, 200);
});
