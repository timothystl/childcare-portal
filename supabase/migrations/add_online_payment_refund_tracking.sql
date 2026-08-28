-- ============================================================
-- ONLINE PAYMENT REFUND/VOID TRACKING
-- ============================================================
-- Follow-up to add_online_payment_tracking.sql. A refund or void is
-- recorded as its own billing_payments row (negative amount) rather than
-- editing or deleting the original — same "never a delta, append a
-- corrective record" instinct as the rest of this app's billing history
-- (see the accepted-shift-swap note in CLAUDE.md: an accepted swap is
-- never deleted, the strikethrough is the record).
--
-- refund_of_payment_id points a reversal row back at the payment it
-- reverses, so the admin UI can (a) find the original transaction to
-- refund/void against Authorize.net and (b) hide the Refund button on a
-- payment that's already been reversed.

ALTER TABLE billing_payments
    ADD COLUMN IF NOT EXISTS refund_of_payment_id BIGINT REFERENCES billing_payments(id);

CREATE INDEX IF NOT EXISTS billing_payments_refund_of_idx
    ON billing_payments (refund_of_payment_id)
    WHERE refund_of_payment_id IS NOT NULL;

-- ============================================================
-- VERIFY (run after applying)
-- ============================================================
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'billing_payments' AND column_name = 'refund_of_payment_id';
--   → present.
-- ============================================================
