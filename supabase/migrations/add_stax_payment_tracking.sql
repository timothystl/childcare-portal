-- ============================================================
-- STAX PAYMENT TRACKING — scaffolding for the Stax (fattmerchant) sandbox
-- ============================================================
-- Parallel to add_online_payment_tracking.sql (Authorize.net). Not a
-- replacement for it — both processors are being evaluated side by side,
-- see CLAUDE.md's Stax integration note. Nothing here touches the
-- Authorize.net columns or any existing anet code path.
--
-- billing_payments.processor / processor_transaction_id already exist and
-- are processor-agnostic (added by add_online_payment_tracking.sql), so a
-- Stax charge just needs processor = 'stax' — no new columns needed there.
-- The one new thing Stax needs that Authorize.net doesn't: a saved
-- customer id per family, so create-stax-charge can reuse the same Stax
-- customer across a family's invoices instead of creating a new one every
-- time (Stax's Customer object is the thing a payment method is vaulted
-- against).

ALTER TABLE families
    ADD COLUMN IF NOT EXISTS stax_customer_id TEXT;

-- ============================================================
-- VERIFY (run after applying)
-- ============================================================
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'families' AND column_name = 'stax_customer_id';
--   → present, nullable, no default.
--
--   SELECT has_column_privilege('anon', 'families', 'stax_customer_id', 'SELECT');
--   → should be false — anon's grant on families is an explicit column
--     allow-list (see R3 in CLAUDE.md), and this column must never be
--     added to it. Only the service role (create-stax-charge, using
--     SUPABASE_SERVICE_ROLE_KEY) reads or writes it.
-- ============================================================
