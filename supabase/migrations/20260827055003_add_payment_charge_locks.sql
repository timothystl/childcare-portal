-- ============================================================
-- PAYMENT CHARGE LOCKS — stop a second real charge for the same invoice
-- ============================================================
-- Independent review, finding C3 (2026-08-27): nothing stopped a second
-- real charge against an invoice already paid at the processor but not yet
-- recorded here. Proven live: invoice 3847 (a $50.00 test invoice) was
-- charged twice, nine minutes apart, both times through Authorize.net's own
-- sandbox, before this fix existed. The unique index on
-- (processor, processor_transaction_id) makes RECORDING idempotent — it
-- does nothing about CHARGING twice, because two charges are two distinct
-- transaction ids and both insert cleanly.
--
-- This table is the missing piece: acquire a 'pending' lock on the invoice
-- BEFORE calling the processor, so a concurrent or repeated attempt (a
-- double-click, two open tabs, a retry after an ambiguous failure) loses the
-- race at the database rather than reaching the processor a second time.
--
--   - One pending lock per invoice, enforced by a partial unique index —
--     not one per family or one globally, since a family can legitimately
--     have two different invoices in flight (unlikely, but not a reason to
--     serialize unrelated charges).
--   - idempotency_key is generated server-side per attempt and is intended
--     to be handed to the processor's own idempotency mechanism where one
--     exists (Stax: the `idempotency_id` field on POST /charge — confirmed
--     against Stax's own docs: a repeated request with the same
--     idempotency_id returns the ORIGINAL transaction rather than creating a
--     new charge). That is the second, independent layer: even if this
--     table's lock were somehow bypassed, the processor itself refuses to
--     double-charge for the same attempt.
--   - A lock resolves to 'succeeded' or 'failed'. It must NEVER be released
--     back to open-for-retry on an AMBIGUOUS outcome (network error/timeout
--     talking to the processor, or the charge succeeding at the processor
--     but our own recording insert failing) — that ambiguity is exactly the
--     case that produced the live double-charge, and an ambiguous outcome
--     must block further attempts until a human resolves it, not invite a
--     retry. See charge-stax-payment's use of this table for the exact
--     state machine.
--
-- Service-role only, like the rest of billing_* — this is written and read
-- exclusively from edge functions holding the service role key, never from
-- a browser session.
-- ============================================================

CREATE TABLE IF NOT EXISTS payment_charge_locks (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invoice_id         bigint NOT NULL REFERENCES billing_invoices(id),
    family_id          uuid NOT NULL,
    processor          text NOT NULL,
    status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
    idempotency_key    text NOT NULL,
    processor_transaction_id text,
    note               text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    resolved_at        timestamptz
);

-- The core guarantee: only one 'pending' lock can exist per invoice at a
-- time. A second INSERT while one is pending hits this and fails with
-- 23505 — the caller treats that as "already in progress," not an error.
CREATE UNIQUE INDEX IF NOT EXISTS payment_charge_locks_pending_idx
    ON payment_charge_locks (invoice_id) WHERE (status = 'pending');

CREATE INDEX IF NOT EXISTS payment_charge_locks_invoice_idx ON payment_charge_locks (invoice_id);
CREATE INDEX IF NOT EXISTS payment_charge_locks_family_idx ON payment_charge_locks (family_id);

ALTER TABLE payment_charge_locks ENABLE ROW LEVEL SECURITY;
-- No policies at all, deliberately — deny-all to anon and authenticated,
-- same posture already used for parent_accounts / pin_reset_tokens /
-- staff_clock_notifications. Only the service role (which bypasses RLS)
-- ever touches this table.
REVOKE ALL ON payment_charge_locks FROM anon, authenticated, PUBLIC;

-- ============================================================
-- VERIFY (run after applying)
-- ============================================================
--   SELECT has_table_privilege('anon', 'payment_charge_locks', 'INSERT');
--   SELECT has_table_privilege('authenticated', 'payment_charge_locks', 'SELECT');
--   -> both should be false.
--
--   INSERT INTO payment_charge_locks (invoice_id, family_id, processor, idempotency_key)
--     VALUES (1, gen_random_uuid(), 'test', 'a');
--   INSERT INTO payment_charge_locks (invoice_id, family_id, processor, idempotency_key)
--     VALUES (1, gen_random_uuid(), 'test', 'b');
--   -> the second insert should raise a unique_violation (23505) as long as
--      the first row is still 'pending'.
-- ============================================================
