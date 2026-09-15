// ============================================================
// backfill-stax-processor-fees — fills in Stax's interchange_fee after
// settlement, for rows charge-stax-payment recorded before Stax had
// computed it
// ============================================================
// A real production charge on 2026-09-14 (transaction
// cc74254f-dd07-4177-a2f8-d54d1ee78634, $1,362.75) proved that Stax's
// interchange_fee is NOT available synchronously at charge time: it came
// back null even though the charge succeeded, while batched_at was already
// set and settled_at was still null. The fee appears to only be computed
// once Stax actually settles the transaction — typically the next business
// day, not at authorization.
//
// This job re-checks Stax for any billing_payments row still missing a fee,
// using the exact same authenticated GET /transaction/{id} call
// charge-stax-payment, stax-webhook, and reconcile-stax-payments already
// treat as the one source of truth, and the same extractStaxPaymentFields()
// reading of it. When a fee comes back, stax_backfill_processor_fee()
// applies it with the identical proportional split stax_finalize_charge
// uses at charge time — see that RPC (migration
// 20260915130000_stax_processor_fee_backfill.sql) for why that's safe to
// call repeatedly.
//
// ⚠️ UNVERIFIED WHETHER PER-TRANSACTION SETTLEMENT DATA EVER ARRIVES THIS
// WAY. It's possible Stax only ever exposes real fee totals through a
// monthly merchant statement/reconciliation report rather than back-filling
// interchange_fee onto the transaction object itself. This job is written
// so that possibility costs nothing if true: it only ever writes a fee it
// actually read from a real GET /transaction/{id} response, only within
// BACKFILL_WINDOW_DAYS of the original charge, and simply leaves
// processor_fee null forever if Stax never populates it — no invented
// numbers, nothing downstream blocked on it. Watch the admin_audit_log rows
// this job writes: if `stillPending` never drops for transactions older
// than a week or two, that's the sign this endpoint truly never settles
// the fee, and a monthly-statement import is the real next step instead.
//
// Deploy:   supabase functions deploy backfill-stax-processor-fees
// Schedule: 20260915130000_stax_processor_fee_backfill.sql (pg_cron + pg_net)
// Secrets:  STAX_API_KEY (already set for the other Stax functions)
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isAuthorizedCronRequest, unauthorizedCronResponse } from "../_shared/cron-auth.ts";
import { extractStaxPaymentFields } from "../_shared/stax-transaction-fields.ts";
import { json } from "../_shared/http.ts";

const STAX_API_URL = "https://apiprod.fattlabs.com";

// ⚠️ MERCHANT PIN — the line between test money and real money. See
// reconcile-stax-payments/index.ts for the full explanation; this is the
// same check, duplicated the same way it already is across every other
// Stax-calling function in this repo.
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

const BACKFILL_WINDOW_DAYS = 60; // give Stax up to two months before giving up
const MAX_TRANSACTIONS_PER_RUN = 40; // keep each run's Stax API usage bounded

async function verifyTransaction(apiKey: string, id: string): Promise<any | null> {
    const res = await fetch(`${STAX_API_URL}/transaction/${encodeURIComponent(id)}`, {
        headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    const t = body?.data && typeof body.data === "object" ? body.data : body;
    return t?.id ? t : null;
}

/** billing_payments only ever stores a per-invoice/per-credit row id like
 *  `{stax transaction id}-inv123` or `{stax transaction id}-credit` — strip
 *  that suffix to get back the real Stax transaction id to look up. Same
 *  helper as admin-refund-stax-payment/index.ts. */
function baseTransactionId(processorTransactionId: string): string {
    return processorTransactionId.replace(/-inv\d+$/, "").replace(/-credit$/, "");
}

serve(async (req) => {
    if (!await isAuthorizedCronRequest(req)) return unauthorizedCronResponse();
    try {
        const apiKey = Deno.env.get("STAX_API_KEY");
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        if (!apiKey) return json({ error: "Stax is not configured" }, 500);
        await assertStaxMerchant(apiKey);
        const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

        const windowStart = new Date(Date.now() - BACKFILL_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
        const { data: pending, error: pendingErr } = await admin
            .from("billing_payments")
            .select("processor_transaction_id, created_at")
            .eq("processor", "stax")
            .is("processor_fee", null)
            .is("refund_of_payment_id", null)
            .gt("amount", 0)
            .gte("created_at", windowStart)
            .not("processor_transaction_id", "is", null);
        if (pendingErr) return json({ error: "Could not load pending Stax payments" }, 500);

        // Try the oldest pending transactions first — they're the most
        // likely to have settled, and this keeps a large backlog from
        // starving older rows out of every run's MAX_TRANSACTIONS_PER_RUN cap.
        const earliestByTransaction = new Map<string, string>();
        for (const row of pending || []) {
            const id = baseTransactionId(String(row.processor_transaction_id || ""));
            if (!id) continue;
            const createdAt = String(row.created_at || "");
            const existing = earliestByTransaction.get(id);
            if (!existing || createdAt < existing) earliestByTransaction.set(id, createdAt);
        }
        const candidates = Array.from(earliestByTransaction.keys())
            .sort((a, b) => (earliestByTransaction.get(a)! < earliestByTransaction.get(b)! ? -1 : 1));

        let transactionsUpdated = 0;
        let rowsFilled = 0;
        let stillPending = 0;
        for (const transactionId of candidates.slice(0, MAX_TRANSACTIONS_PER_RUN)) {
            const t = await verifyTransaction(apiKey, transactionId);
            if (!t) { stillPending++; continue; }
            const { processorFee } = extractStaxPaymentFields(t);
            if (processorFee == null) { stillPending++; continue; }

            const { data: result, error: rpcErr } = await admin.rpc("stax_backfill_processor_fee", {
                p_transaction_id: transactionId,
                p_processor_fee: processorFee,
            });
            if (rpcErr) {
                console.error("backfill-stax-processor-fees: rpc failed", transactionId, rpcErr.message);
                continue;
            }
            const updated = Number((result as { updated?: number } | null)?.updated) || 0;
            if (updated > 0) { transactionsUpdated++; rowsFilled += updated; }
        }

        await admin.from("admin_audit_log").insert({
            admin_email: "backfill-stax-processor-fees", action: "processor_fee_backfill", entity: "billing_payment",
            details: { candidates: candidates.length, transactionsUpdated, rowsFilled, stillPending },
        }).then(() => {}, (e: unknown) => console.error("backfill-stax-processor-fees: audit write failed", e));

        return json({ candidates: candidates.length, transactionsUpdated, rowsFilled, stillPending }, 200);
    } catch (err) {
        return json({ error: (err as Error).message }, 500);
    }
});
