// ============================================================
// authorizenet-webhook — the only thing that marks an invoice paid,
// refunded, or voided online
// ============================================================
// create-payment-session hands the family off to Authorize.net's hosted
// page and never hears back directly — the browser return URL is purely
// cosmetic (a parent can close the tab, lose signal, or the redirect can
// fail, and none of that should change what's owed). admin-refund-payment
// is the same story from the office side: it only asks Authorize.net to
// reverse a charge, it never touches billing_payments itself. This
// function is the one authoritative record for all three: Authorize.net
// calls it server-to-server once something actually happens, we re-fetch
// that transaction from Authorize.net's own API (never trust the webhook
// body), and only then do we write to billing_payments.
//
//   1. Every request is signature-verified (HMAC-SHA512 over the raw body,
//      keyed by AUTHORIZENET_SIGNATURE_KEY) before anything in it is read.
//      An unsigned or mis-signed request is rejected outright. GET/HEAD and
//      an unsigned POST before the key exists both return a bare 200 —
//      Authorize.net's own Merchant Interface pings the URL to confirm it's
//      reachable BEFORE the webhook is saved and a key is even issued, and
//      a 401/405/500 there reads as "invalid endpoint" and blocks creation.
//   2. The webhook payload is treated as a pointer, not a source of truth:
//      it tells us a transaction id exists; getTransactionDetailsRequest
//      (called with our own merchant credentials) is what actually supplies
//      the amount, the invoiceNumber (for a charge) or the original
//      transaction it reverses (for a refund/void).
//   3. Idempotent by construction — billing_payments_processor_txn_idx
//      (processor, processor_transaction_id) is a unique index, so a
//      webhook retry (Authorize.net resends on anything but 200) cannot
//      double-record the same event. A duplicate is treated as success.
//   4. A refund or void is recorded as its OWN negative billing_payments
//      row (refund_of_payment_id pointing at the original), never by
//      editing or deleting the original charge — same "append a
//      corrective record" instinct as the rest of this app's billing
//      history. Only an approved event (responseCode 1) is ever recorded.
//   5. A payment receipt email fires only on a genuinely NEW charge record
//      (recordAndReconcile's duplicate:false branch) — a webhook retry that
//      lands on the idempotent-duplicate path sends nothing a second time.
//      A receipt-send failure is logged and swallowed; it never fails the
//      request or undoes the payment, which has already happened.
//
// Deploy:  supabase functions deploy authorizenet-webhook --no-verify-jwt
//          (this endpoint is called by Authorize.net, not a signed-in user —
//          it authenticates via the HMAC signature instead of a JWT)
// Secrets: AUTHORIZENET_API_LOGIN_ID, AUTHORIZENET_TRANSACTION_KEY,
//          AUTHORIZENET_SIGNATURE_KEY, AUTHORIZENET_ENVIRONMENT,
//          RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_REPLY_TO (shared with
//          send-invoice — these are already set at the project level)
//
// Register this function's URL in the Authorize.net Merchant Interface
// (Account → Settings → Webhooks) for net.authorize.payment.authcapture
// .created, net.authorize.payment.refund.created and
// net.authorize.payment.void.created, and copy the Signature Key it shows
// you into the AUTHORIZENET_SIGNATURE_KEY secret.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANET_API_URL = {
    sandbox:    "https://apitest.authorize.net/xml/v1/request.api",
    production: "https://api.authorize.net/xml/v1/request.api",
};

function json(body: unknown, status: number) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function hexToBytes(hex: string): Uint8Array {
    const clean = hex.trim().replace(/^0x/i, "");
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}

function bytesToHex(buf: ArrayBuffer): string {
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function verifySignature(rawBody: string, headerSig: string | null, signatureKeyHex: string): Promise<boolean> {
    if (!headerSig) return false;
    const provided = headerSig.replace(/^sha512=/i, "").trim().toUpperCase();
    const key = await crypto.subtle.importKey(
        "raw", hexToBytes(signatureKeyHex), { name: "HMAC", hash: "SHA-512" }, false, ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    const computed = bytesToHex(mac);
    // Constant-time-ish compare; both are fixed-length hex strings.
    if (computed.length !== provided.length) return false;
    let diff = 0;
    for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ provided.charCodeAt(i);
    return diff === 0;
}

async function anetTransactionDetails(apiUrl: string, loginId: string, transactionKey: string, transId: string): Promise<any> {
    const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            getTransactionDetailsRequest: {
                merchantAuthentication: { name: loginId, transactionKey },
                transId,
            },
        }),
    });
    const rawText = (await res.text()).replace(/^﻿/, "");
    return JSON.parse(rawText);
}

function escHtml(s: unknown): string {
    return String(s ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const money = (n: unknown) =>
    "$" + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString("en-US", {
        minimumFractionDigits: 2, maximumFractionDigits: 2,
    });

/**
 * A payment receipt, sent only for a genuinely new charge (never a retry —
 * the caller only reaches here when recordAndReconcile() returned
 * recorded:true, not duplicate:true, so a webhook redelivery cannot send a
 * second copy). Deliberately the same branding and markup as
 * charge-stax-payment's sendReceiptEmail — a family paying by Authorize.net
 * should get the identical-looking receipt as one paying by Stax. Redesigned
 * 2026-08-28 from a director design mockup (checkmark, Invoice/Paid on/
 * Confirmation# box, current-month/prior-balance breakdown, "View billing
 * account" link). No card-brand/last-four line here — unlike charge-stax-
 * payment, nothing in this file extracts card metadata from Authorize.net's
 * transaction details response, and this repo does not guess at an
 * unverified field name for a live payment API; buildReceiptHtml already
 * omits that row gracefully when it's not supplied.
 */
async function sendReceiptEmail(admin: any, o: {
    familyId: string; invoiceId: number; amountPaid: number; transId: string;
}): Promise<void> {
    const apiKey = Deno.env.get("RESEND_API_KEY");
    const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev";
    // No secret configured is not an error worth failing the webhook over —
    // the payment is already recorded either way; the receipt is a courtesy
    // on top of it, not the thing this endpoint exists to guarantee.
    if (!apiKey) { console.warn("authorizenet-webhook: RESEND_API_KEY not set, skipping receipt"); return; }

    const { data: fam } = await admin.from("families")
        .select("parent_name, parent_email").eq("id", o.familyId).maybeSingle();
    if (!fam?.parent_email) return;

    const { data: invoice } = await admin.from("billing_invoices")
        .select("final_amount, billing_cycles(month)")
        .eq("id", o.invoiceId).maybeSingle();
    const finalAmount = Number(invoice?.final_amount) || 0;
    const anchorMonth = (invoice as any)?.billing_cycles?.month || "";

    // Same reasoning as charge-stax-payment's copy: re-read the actual
    // billing_payments rows this transaction produced (allocateAcrossPaymentRows
    // below can roll one Authorize.net settlement across several unpaid
    // invoices, tagging each row's processor_transaction_id with
    // "-inv<id>") rather than trusting o.amountPaid alone, so the receipt's
    // current-month/prior-balance split can never disagree with the ledger.
    const { data: paymentRows } = await admin.from("billing_payments")
        .select("amount, invoice_id, billing_invoices(billing_cycles(month))")
        .eq("processor", "authorizenet")
        .or(`processor_transaction_id.eq.${o.transId},processor_transaction_id.like.${o.transId}-inv%`);
    let currentMonthAmount = 0, priorBalanceAmount = 0;
    for (const row of (paymentRows || []) as any[]) {
        const rowMonth = row?.billing_invoices?.billing_cycles?.month || "";
        if (rowMonth && anchorMonth && rowMonth === anchorMonth) currentMonthAmount += Number(row.amount) || 0;
        else priorBalanceAmount += Number(row.amount) || 0;
    }
    const totalPaid = (currentMonthAmount + priorBalanceAmount) > 0
        ? currentMonthAmount + priorBalanceAmount : Number(o.amountPaid) || 0;

    const { data: allInvoicePayments } = await admin.from("billing_payments")
        .select("amount").eq("invoice_id", o.invoiceId);
    const totalPaidOnThisInvoice = (allInvoicePayments || [])
        .reduce((s: number, p: { amount: number }) => s + (Number(p.amount) || 0), 0);
    const balanceRemaining = Math.max(0, finalAmount - totalPaidOnThisInvoice);

    const invoiceNumber = `INV-${o.invoiceId}`;
    const paidOn = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

    const html = buildReceiptHtml({
        familyName: fam.parent_name || "there",
        invoiceNumber, paidOn, paymentMethodLine: null,
        confirmationNumber: o.transId,
        totalPaid, currentMonthAmount, priorBalanceAmount,
        balanceRemaining,
    });

    try {
        await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                from: fromEmail,
                to: [String(fam.parent_email).trim()],
                subject: `Payment received — Timothy Lutheran MDO`,
                html,
            }),
        });
    } catch (e) {
        // A failed receipt email must never undo or fail the payment record
        // itself — the charge already happened and is already stored.
        console.error("authorizenet-webhook: receipt email failed", e);
    }
}

/** Identical to charge-stax-payment's own copy — see that file for the full comment. */
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
            <img src="https://mdo.timothystl.org/images/logo/myMDO_primary_logo_light.png"
                 alt="my MDO" width="120" height="auto" style="display:block;margin:0 auto 10px;">
            <p style="margin:0;color:#F5B731;font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;">Timothy Lutheran Church</p>
            <p style="margin:4px 0 0;color:rgba(255,255,255,.75);font-size:13px;">Mother's Day Out</p>
          </td>
        </tr>
        <tr>
          <td style="padding:34px 32px 8px;text-align:center;">
            <table cellpadding="0" cellspacing="0" style="margin:0 auto 16px;">
              <tr><td width="52" height="52" style="background:#C9E6DC;border-radius:50%;text-align:center;vertical-align:middle;font-size:26px;color:#3A7B60;">&#10003;</td></tr>
            </table>
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
            <a href="https://mdo.timothystl.org/portal.html"
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

type DueRow = { id: number; due: number; month: string };

/**
 * Same due-set builder as create-payment-session's copy — every unpaid
 * invoice for this family from the oldest through anchorMonth. Recomputed
 * fresh at settlement time rather than trusting a stored list: a webhook
 * retry (or one that lands minutes later) should reflect whatever is
 * actually still owed right now, not a stale intent from when the session
 * was created.
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

/**
 * Allocates one settled amount across a due-set, oldest invoice first,
 * recording one billing_payments row per invoice it actually covers.
 * Idempotent per invoice: processor_transaction_id is the real transaction
 * id suffixed with the invoice id, so a retry re-allocating the SAME
 * due-set hits the same unique keys and is treated as already-recorded —
 * see billing_payments_processor_txn_idx.
 *
 * ⚠️ Returns any leftover (2026-08-27, independent review finding C2). The
 * due-set is recomputed fresh at settlement time (deliberately — see its own
 * header), which means it can have SHRUNK since the payment session was
 * created if another payment landed on one of its invoices in between. The
 * amount actually settled at Authorize.net does not shrink to match. The
 * caller is responsible for recording (never dropping) whatever this loop
 * could not place on a real invoice.
 */
async function allocateAcrossDueSet(admin: any, o: {
    familyId: string; dueSet: DueRow[]; totalAmount: number; transId: string; note: string;
}): Promise<{ recorded: boolean; anyNew: boolean; touchedInvoiceIds: number[]; leftover: number }> {
    let remaining = Math.round(o.totalAmount * 100) / 100;
    let anyNew = false;
    const touched: number[] = [];

    for (const row of o.dueSet) {
        if (remaining <= 0.004) break;
        const amt = Math.round(Math.min(remaining, row.due) * 100) / 100;
        if (amt <= 0.004) continue;

        const result = await recordAndReconcile(admin, {
            family_id: o.familyId, invoice_id: row.id, amount: amt,
            note: o.note,
            processor_transaction_id: `${o.transId}-inv${row.id}`,
        });
        if (result.recorded) anyNew = true;
        touched.push(row.id);
        remaining = Math.round((remaining - amt) * 100) / 100;
    }

    return { recorded: touched.length > 0, anyNew, touchedInvoiceIds: touched, leftover: Math.max(0, remaining) };
}

/**
 * Records settled money that couldn't be placed on any invoice (C2 above) as
 * an unapplied credit — invoice_id NULL is allowed by schema specifically for
 * this — rather than dropping it. Never silent: audit-logged and mailed to
 * the office so someone applies it to a future invoice or refunds it.
 */
async function recordUnappliedCredit(admin: any, o: {
    familyId: string; amount: number; processor: string; transId: string; note: string;
}): Promise<void> {
    const amt = Math.round(o.amount * 100) / 100;
    if (amt <= 0.004) return;
    const { error } = await admin.from("billing_payments").insert({
        family_id: o.familyId, invoice_id: null, amount: amt,
        payment_date: new Date().toISOString().slice(0, 10),
        payment_method: "card", note: o.note,
        created_by: "authorizenet-webhook", processor: o.processor,
        processor_transaction_id: `${o.transId}-credit`,
    });
    if (error && String(error.code) !== "23505" && !/duplicate key/i.test(error.message || "")) {
        console.error("recordUnappliedCredit: insert failed", error);
    }
    await admin.from("admin_audit_log").insert({
        admin_email: "authorizenet-webhook", action: "online_payment_overage", entity: "billing_invoice",
        details: { family_id: o.familyId, amount: amt, processor_transaction_id: o.transId },
    }).then(() => {}, (e: unknown) => console.error("recordUnappliedCredit: audit write failed", e));

    const apiKey = Deno.env.get("RESEND_API_KEY");
    const toEmail = Deno.env.get("RESEND_REPLY_TO") || "mdo@timothystl.org";
    if (!apiKey) return;
    try {
        await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                from: Deno.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev",
                to: [toEmail],
                subject: "⚠️ Unapplied payment credit recorded",
                html: `<p style="font-family:Georgia,serif;">A family's online payment settled for more than their currently-owed balance covered. $${amt.toFixed(2)} was recorded as an unapplied credit (no invoice attached) rather than being dropped. Check Invoices → Accounts Receivable and apply it to a future bill or refund it.</p><p style="font-family:Georgia,serif;color:#888;font-size:12px;">Family: ${escHtml(o.familyId)} · Transaction: ${escHtml(o.transId)}</p>`,
            }),
        });
    } catch (e) {
        console.error("recordUnappliedCredit: alert email failed", e);
    }
}

type PaymentRow = { id: number; invoice_id: number; family_id: string; amount: number; alreadyReversed: number };

/**
 * ⚠️ Finds every billing_payments row a single Authorize.net charge could
 * have been split across (2026-08-27). allocateAcrossDueSet suffixes each
 * row's processor_transaction_id with "-inv<invoiceId>", so a real refund/
 * void arrives referencing the BARE original transaction id — an exact-
 * match lookup on that bare id (the old code here) matches zero rows for
 * any charge the rollup spread across more than one invoice. Matches the
 * bare id (pre-rollup rows, and any charge that only ever covered one
 * invoice) OR any "<id>-inv*" suffix, sorted oldest-invoice-first so a
 * partial reversal is applied in the same order the original charge was.
 *
 * ⚠️ Also returns how much of EACH row has already been reversed
 * (2026-08-27, independent review finding H2). A second, independent
 * refund/void of the same original charge — e.g. two partial dashboard
 * refunds issued separately — must cap against what's still un-reversed on
 * a row, not against the row's full original amount, or the second
 * reversal double-counts money already given back.
 */
async function findOriginalPaymentRows(admin: any, processor: string, baseTransactionId: string): Promise<PaymentRow[]> {
    const { data } = await admin
        .from("billing_payments")
        .select("id, invoice_id, family_id, amount, billing_invoices(billing_cycles(month))")
        .eq("processor", processor)
        .or(`processor_transaction_id.eq.${baseTransactionId},processor_transaction_id.like.${baseTransactionId}-inv%`);
    const rows = (data || []) as any[];
    rows.sort((a, b) => {
        const ma = a?.billing_invoices?.billing_cycles?.month || "";
        const mb = b?.billing_invoices?.billing_cycles?.month || "";
        return ma.localeCompare(mb);
    });

    const ids = rows.map(r => r.id);
    const reversedByRow = new Map<number, number>();
    if (ids.length) {
        const { data: reversals } = await admin
            .from("billing_payments").select("refund_of_payment_id, amount").in("refund_of_payment_id", ids);
        for (const r of (reversals || [])) {
            const key = r.refund_of_payment_id as number;
            reversedByRow.set(key, (reversedByRow.get(key) || 0) + Math.abs(Number(r.amount) || 0));
        }
    }

    return rows.map(r => ({
        id: r.id, invoice_id: r.invoice_id, family_id: r.family_id, amount: Number(r.amount) || 0,
        alreadyReversed: reversedByRow.get(r.id) || 0,
    }));
}

/**
 * Allocates one refund/void total across every payment row a charge was
 * split into, oldest-invoice-first, capping each reversal at that row's own
 * REMAINING un-reversed amount (amount minus whatever prior reversal already
 * took), so a second independent reversal of the same charge can never
 * exceed what was actually charged. Idempotent per row via a row-suffixed
 * transaction id. Any amount this call can't place (the processor reports
 * reversing more than this app has any un-reversed record of) is returned as
 * `leftover` rather than silently absorbed into the wrong row.
 */
async function reverseAcrossPaymentRows(admin: any, o: {
    rows: PaymentRow[]; totalAmount: number; reversalTransactionId: string; note: string;
}): Promise<{ anyNew: boolean; touchedInvoiceIds: number[]; leftover: number }> {
    let remaining = Math.round(o.totalAmount * 100) / 100;
    let anyNew = false;
    const touched: number[] = [];

    for (const row of o.rows) {
        if (remaining <= 0.004) break;
        const reversible = Math.round((row.amount - row.alreadyReversed) * 100) / 100;
        if (reversible <= 0.004) continue;
        const amt = Math.round(Math.min(remaining, reversible) * 100) / 100;
        if (amt <= 0.004) continue;

        const result = await recordAndReconcile(admin, {
            family_id: row.family_id, invoice_id: row.invoice_id, amount: -amt,
            note: o.note,
            processor_transaction_id: `${o.reversalTransactionId}-row${row.id}`,
            refund_of_payment_id: row.id,
        });
        if (result.recorded) anyNew = true;
        touched.push(row.invoice_id);
        remaining = Math.round((remaining - amt) * 100) / 100;
    }

    return { anyNew, touchedInvoiceIds: touched, leftover: Math.max(0, remaining) };
}

/** Insert one billing_payments row (idempotent on processor+transaction id) and reconcile the invoice. */
async function recordAndReconcile(admin: any, row: {
    family_id: string; invoice_id: number; amount: number; note: string;
    processor_transaction_id: string; refund_of_payment_id?: number | null;
}): Promise<{ recorded: boolean; duplicate?: boolean }> {
    const { error: insErr } = await admin.from("billing_payments").insert({
        family_id:                 row.family_id,
        invoice_id:                row.invoice_id,
        amount:                    row.amount,
        payment_date:              new Date().toISOString().slice(0, 10),
        payment_method:            "card",
        note:                      row.note,
        created_by:                "authorizenet-webhook",
        processor:                 "authorizenet",
        processor_transaction_id:  row.processor_transaction_id,
        refund_of_payment_id:      row.refund_of_payment_id ?? null,
    });
    if (insErr) {
        if (String(insErr.code) === "23505" || /duplicate key/i.test(insErr.message || "")) {
            return { recorded: false, duplicate: true };
        }
        throw new Error(insErr.message);
    }

    const { data: paymentRows } = await admin
        .from("billing_payments").select("amount").eq("invoice_id", row.invoice_id);
    const totalPaid = (paymentRows || []).reduce((s: number, p: { amount: number }) => s + (Number(p.amount) || 0), 0);
    const { data: invoiceRow } = await admin
        .from("billing_invoices").select("final_amount").eq("id", row.invoice_id).maybeSingle();
    const finalAmount = Number(invoiceRow?.final_amount) || 0;
    const newStatus = totalPaid >= finalAmount && finalAmount > 0 ? "paid" : (totalPaid > 0 ? "partial" : "sent");
    await admin.from("billing_invoices").update({ status: newStatus }).eq("id", row.invoice_id);

    return { recorded: true };
}

serve(async (req) => {
    // Authorize.net's own Merchant Interface pings the URL (GET/HEAD, no
    // signature) to confirm it's reachable BEFORE the webhook is saved and a
    // signature key is even issued — a 405/500 here reads as "invalid
    // endpoint" and blocks creation. A bare 200 costs nothing: nothing
    // downstream of this line is reachable without a valid POST + signature.
    if (req.method === "GET" || req.method === "HEAD") return json({ ok: true }, 200);
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const rawBody = await req.text();
    const signatureKey = Deno.env.get("AUTHORIZENET_SIGNATURE_KEY");
    // Same reachability-check problem can arrive as a POST with no/blank
    // signature before the key exists. Acknowledge rather than 500, so
    // webhook creation isn't blocked on a secret that can only be set AFTER
    // creation returns it. Once the secret is set, an unsigned POST still
    // never reaches the signature check below — this only fires pre-setup.
    if (!signatureKey) return json({ received: true, ignored: "webhook not configured yet" }, 200);

    const sigHeader = req.headers.get("X-ANET-Signature");
    const ok = await verifySignature(rawBody, sigHeader, signatureKey).catch(() => false);
    if (!ok) return json({ error: "Bad signature" }, 401);

    let event: any;
    try { event = JSON.parse(rawBody); } catch { return json({ error: "Bad payload" }, 400); }

    const eventType: string = event?.eventType || "";
    const isCharge = eventType === "net.authorize.payment.authcapture.created";
    const isRefund = eventType === "net.authorize.payment.refund.created";
    const isVoid   = eventType === "net.authorize.payment.void.created";
    if (!isCharge && !isRefund && !isVoid) {
        return json({ received: true, ignored: eventType || "unknown" }, 200);
    }

    const transId = event?.payload?.id;
    if (!transId) return json({ received: true, ignored: "no transaction id" }, 200);

    const env = (Deno.env.get("AUTHORIZENET_ENVIRONMENT") || "sandbox").toLowerCase();
    const apiUrl = ANET_API_URL[env as "sandbox" | "production"] || ANET_API_URL.sandbox;
    const loginId = Deno.env.get("AUTHORIZENET_API_LOGIN_ID");
    const transactionKey = Deno.env.get("AUTHORIZENET_TRANSACTION_KEY");
    if (!loginId || !transactionKey) return json({ error: "Payment processing is not configured" }, 500);

    // ── Re-fetch the transaction from Authorize.net itself. The webhook
    // body is just a pointer; this call is the source of truth for amount
    // and, for a charge, which invoice it was for. ──────────────────────
    let detail: any;
    try {
        detail = await anetTransactionDetails(apiUrl, loginId, transactionKey, String(transId));
    } catch { return json({ error: "Could not read transaction details" }, 502); }

    const tx = detail?.transaction;
    if (!tx || detail?.messages?.resultCode !== "Ok") {
        return json({ received: true, ignored: "transaction lookup failed" }, 200);
    }
    // responseCode: 1 = approved. Anything else (declined, error) should
    // not be recorded.
    if (String(tx.responseCode) !== "1") {
        return json({ received: true, ignored: "transaction not approved" }, 200);
    }

    const admin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (isCharge) {
        const invoiceNumber: string = tx?.order?.invoiceNumber || "";
        const m = /^mdoinv-(\d+)$/.exec(invoiceNumber);
        if (!m) return json({ received: true, ignored: "no matching invoice reference" }, 200);
        const invoiceId = Number(m[1]);
        const amount = Number(tx.authAmount ?? tx.settleAmount ?? 0);
        if (!Number.isFinite(amount) || amount <= 0) {
            return json({ received: true, ignored: "zero or invalid amount" }, 200);
        }

        const { data: invoice, error: invErr } = await admin
            .from("billing_invoices").select("id, family_id, billing_cycles(month)").eq("id", invoiceId).maybeSingle();
        if (invErr) return json({ error: invErr.message }, 500);
        if (!invoice) return json({ received: true, ignored: "invoice not found" }, 200);

        // ⚠️ Refuse to re-allocate a transaction this app has already
        // recorded anywhere (2026-08-27, independent review findings H1/M1).
        // A webhook retry, or reconcile-anet-payments replaying a charge it
        // wrongly believed was missing, must never re-run the allocation —
        // the due-set is recomputed fresh each time, so a second run can land
        // on a DIFFERENT invoice than the first and credit money twice. This
        // check has to match the same bare-id-OR-suffix shape the recording
        // itself uses, or it's the exact bug it's meant to prevent.
        const { data: alreadyRows } = await admin
            .from("billing_payments").select("id")
            .eq("processor", "authorizenet")
            .or(`processor_transaction_id.eq.${transId},processor_transaction_id.like.${transId}-inv%`)
            .limit(1);
        if ((alreadyRows || []).length > 0) {
            return json({ received: true, ignored: "already recorded" }, 200);
        }

        // ⚠️ Rolls up older unpaid months (2026-08-27) — mirrors
        // create-payment-session's own computeFamilyDueSet exactly, so the
        // amount Authorize.net actually settled gets spread across every
        // invoice the family's payment session included, oldest first,
        // instead of being dumped entirely onto the anchor invoice.
        const anchorMonth = String((invoice as any)?.billing_cycles?.month || "").slice(0, 7);
        const dueSet = await computeFamilyDueSet(admin, invoice.family_id, anchorMonth);
        // A due-set that no longer includes the anchor (e.g. already paid by
        // another means between session creation and settlement) still needs
        // somewhere to record a real, approved charge — fall back to the
        // anchor invoice alone rather than silently dropping the money.
        const allocationSet: DueRow[] = dueSet.length ? dueSet : [{ id: invoice.id, due: amount, month: anchorMonth }];

        const result = await allocateAcrossDueSet(admin, {
            familyId: invoice.family_id, dueSet: allocationSet, totalAmount: amount,
            transId: String(transId), note: "Paid online via Authorize.net",
        }).catch((e: Error) => ({ error: e.message } as any));
        if ((result as any)?.error) return json({ error: (result as any).error }, 500);
        const alloc = result as { recorded: boolean; anyNew: boolean; touchedInvoiceIds: number[]; leftover: number };

        // ⚠️ Never drop settled money (2026-08-27, C2). The due-set can have
        // shrunk since the payment session was created; whatever this
        // settlement couldn't place on a real invoice becomes an unapplied
        // credit instead of vanishing.
        if (alloc.leftover > 0.004) {
            await recordUnappliedCredit(admin, {
                familyId: invoice.family_id, amount: alloc.leftover, processor: "authorizenet",
                transId: String(transId), note: "Unapplied credit — Authorize.net settlement exceeded amount owed",
            });
        }

        await admin.from("admin_audit_log").insert({
            admin_email: "authorizenet-webhook", action: "online_payment", entity: "billing_invoice",
            details: { invoice_ids: alloc.touchedInvoiceIds, amount, leftover: alloc.leftover, processor_transaction_id: String(transId) },
        }).then(() => {}, (e: unknown) => console.error("authorizenet-webhook: audit write failed", e));

        // Only on a genuinely new record — never on a webhook retry hitting
        // the duplicate branch, or the family gets the same receipt twice.
        if (alloc.anyNew) {
            await sendReceiptEmail(admin, {
                familyId: invoice.family_id, invoiceId: invoice.id,
                amountPaid: amount, transId: String(transId),
            });
        }

        return json({ received: true, ...alloc, invoiceId: invoice.id, amount }, 200);
    }

    // ── Refund or void: find the original charge this reverses ─────────
    // ⚠️ Verified live against the sandbox, and the two are NOT symmetric:
    //   - A refund gets its own new transaction id; getTransactionDetailsRequest
    //     on it returns refTransId/refTransID pointing at the original.
    //   - A void does NOT create a new transaction — Authorize.net returns the
    //     SAME transId as the charge it voids (confirmed: voiding transaction
    //     80058619513 returned transId 80058619513, not a new one), and
    //     getTransactionDetailsRequest on it carries NO refTransId/refTransID
    //     field at all (present only in the direct createTransactionRequest
    //     response, not in the details lookup). So for a void, the event's
    //     own transId already IS the original's id — there is no separate
    //     reference field to read.
    const refTransId: string = isVoid ? String(transId) : (tx?.refTransId || tx?.refTransID || "");
    if (!refTransId) return json({ received: true, ignored: "no original transaction reference" }, 200);

    // ⚠️ May be several rows (2026-08-27) — one real Authorize.net charge
    // can be split across multiple invoices by the rollup, so a single
    // refund/void of it has to reverse every row that charge was recorded
    // into, not just one. See findOriginalPaymentRows.
    const originalRows = await findOriginalPaymentRows(admin, "authorizenet", refTransId);
    if (!originalRows.length) return json({ received: true, ignored: "original payment not found" }, 200);
    const originalTotal = originalRows.reduce((s, r) => s + r.amount, 0);

    // A void carries the original auth amount in its own transaction detail;
    // fall back to the original payment's recorded total if that's absent
    // (a full reversal either way — this app only ever submits full
    // refunds/voids, see admin-refund-payment).
    const reverseAmount = Number(tx.authAmount ?? tx.settleAmount ?? originalTotal) || originalTotal || 0;
    if (!(reverseAmount > 0)) return json({ received: true, ignored: "zero or invalid reversal amount" }, 200);

    // A refund's transId is genuinely new and unique on its own. A void's
    // transId is the ORIGINAL charge's id (see the note above) — storing it
    // as-is would collide with the original payment's own row(s) on the
    // (processor, processor_transaction_id) unique index and be silently
    // treated as an already-recorded duplicate, so the void would never
    // actually get recorded. The ":void" suffix keeps it unique.
    const reversalTransactionId = isVoid ? `${transId}:void` : String(transId);

    const result = await reverseAcrossPaymentRows(admin, {
        rows: originalRows, totalAmount: reverseAmount, reversalTransactionId,
        note: isRefund ? "Refund via Authorize.net" : "Void via Authorize.net",
    }).catch((e: Error) => ({ error: e.message } as any));
    if ((result as any)?.error) return json({ error: (result as any).error }, 500);
    const rev = result as { anyNew: boolean; touchedInvoiceIds: number[]; leftover: number };

    // ⚠️ Never silently absorb an over-reversal into the wrong row
    // (2026-08-27, H2). If the processor reports reversing more than this
    // app has any un-reversed record of — e.g. a refund replayed against a
    // charge already fully refunded by other means — that excess is exactly
    // the kind of discrepancy that needs a human, not a best-effort guess.
    if (rev.leftover > 0.004) {
        await admin.from("admin_audit_log").insert({
            admin_email: "authorizenet-webhook", action: "online_reversal_overage", entity: "billing_invoice",
            details: { processor_transaction_id: reversalTransactionId, unmatched_amount: rev.leftover, kind: isRefund ? "refund" : "void" },
        }).then(() => {}, (e: unknown) => console.error("authorizenet-webhook: audit write failed", e));
    }

    await admin.from("admin_audit_log").insert({
        admin_email: "authorizenet-webhook",
        action:      isRefund ? "online_refund" : "online_void",
        entity:      "billing_invoice",
        details:     { invoice_ids: rev.touchedInvoiceIds, amount: -reverseAmount, leftover: rev.leftover, processor_transaction_id: reversalTransactionId },
    }).then(() => {}, (e: unknown) => console.error("authorizenet-webhook: audit write failed", e));

    return json({ received: true, ...rev, invoiceIds: rev.touchedInvoiceIds, amount: -reverseAmount }, 200);
});
