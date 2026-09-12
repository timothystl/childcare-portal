// ============================================================
// extractStaxPaymentFields — shared reading of a verified Stax
// transaction/charge response for fee + funding-method ledger metadata
// ============================================================
// Used by charge-stax-payment (the synchronous POST /charge response),
// stax-webhook, and reconcile-stax-payments (both read the authoritative
// GET /transaction/{id} response) so all three record identical values for
// the exact same shape of Stax object, rather than three slightly
// different readings of the same fields.
//
// Both fields are informational ledger metadata (fee tracking, and knowing
// which families are still paying by card so they can be steered to ACH
// later) — never something a payment should fail or be blocked over. An
// unrecognized or missing value simply comes back null; nothing here ever
// throws.
// ============================================================

export interface StaxPaymentFields {
    /** Stax's own interchange_fee for this transaction, in dollars. */
    processorFee: number | null;
    /** 'card' or 'ach', from Stax's payment_method.method ('card'/'bank'). */
    paymentMethod: "card" | "ach" | null;
}

export function extractStaxPaymentFields(transaction: unknown): StaxPaymentFields {
    const t = (transaction && typeof transaction === "object") ? transaction as Record<string, unknown> : {};

    const feeRaw = t.interchange_fee;
    const feeNum = Number(feeRaw);
    const processorFee = feeRaw != null && Number.isFinite(feeNum) && feeNum >= 0
        ? Math.round(feeNum * 100) / 100
        : null;

    const methodInfo = (t.payment_method && typeof t.payment_method === "object")
        ? t.payment_method as Record<string, unknown>
        : ((t.response as Record<string, unknown> | undefined)?.payment_method && typeof (t.response as Record<string, unknown>).payment_method === "object")
            ? (t.response as Record<string, unknown>).payment_method as Record<string, unknown>
            : {};
    const rawMethod = String(methodInfo?.method || t.method || "").toLowerCase();
    const paymentMethod = rawMethod === "card" ? "card" : rawMethod === "bank" ? "ach" : null;

    return { processorFee, paymentMethod };
}
