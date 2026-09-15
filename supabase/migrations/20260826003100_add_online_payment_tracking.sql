-- ============================================================
-- ONLINE PAYMENT TRACKING — Accept Hosted (Authorize.net) integration
-- ============================================================
-- First payment processor wired into the app. Follows the send-invoice /
-- send-schedule-confirmation posture already established here: the client
-- passes only an invoice id, the server reads and computes every amount,
-- and the processor's own webhook — not the browser — is what actually
-- marks a bill paid.
--
-- Two columns on billing_payments so a webhook retry (Authorize.net resends
-- on anything but a 200) can never double-record the same transaction:
-- processor identifies who sent it, processor_transaction_id is the
-- gateway's own id for that charge. The partial unique index (only when
-- processor_transaction_id is set) leaves every existing hand-entered
-- payment — cash/check/ach/procare imports, all NULL here — untouched.

ALTER TABLE billing_payments
    ADD COLUMN IF NOT EXISTS processor TEXT,
    ADD COLUMN IF NOT EXISTS processor_transaction_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS billing_payments_processor_txn_idx
    ON billing_payments (processor, processor_transaction_id)
    WHERE processor_transaction_id IS NOT NULL;

-- ============================================================
-- VERIFY (run after applying)
-- ============================================================
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'billing_payments'
--      AND column_name IN ('processor','processor_transaction_id');
--   → both present.
--
--   Re-insert the same (processor, processor_transaction_id) pair twice →
--   second insert violates billing_payments_processor_txn_idx.
-- ============================================================
