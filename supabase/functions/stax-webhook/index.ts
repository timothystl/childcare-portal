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

const STAX_API_URL = "https://apiprod.fattlabs.com";

function json(body: unknown, status: number) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
}

async function safeEqual(actual: string, expected: string): Promise<boolean> {
    const encoder = new TextEncoder();
    const [a, b] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(actual)),
        crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    ]);
    const av = new Uint8Array(a);
    const bv = new Uint8Array(b);
    let diff = av.length ^ bv.length;
    for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
    return diff === 0;
}

function cents(value: unknown): number | null {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    const rounded = Math.round(n * 100);
    return Math.abs(n * 100 - rounded) <= 0.000001 ? rounded : null;
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
            .select("id, family_id, charge_amount, status")
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

        const { error: stateErr } = await admin.rpc("stax_set_charge_state", {
            p_lock_id: lock.id,
            p_status: "processor_succeeded",
            p_transaction_id: eventTransactionId,
            p_note: "Recovered/confirmed by verified Stax webhook",
        });
        if (stateErr) return json({ error: "Could not record processor success" }, 500);
        const { data: finalized, error: finalizeErr } = await admin.rpc("stax_finalize_charge", {
            p_lock_id: lock.id,
        });
        if (finalizeErr) return json({ error: "Could not finalize verified charge" }, 500);
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
