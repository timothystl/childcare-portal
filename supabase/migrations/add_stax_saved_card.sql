-- ============================================================
-- SAVED CARD (Stax) — PCI-compliant "pay again without re-entering a card"
-- ============================================================
-- Storing NOTHING here that touches PCI cardholder-data scope: a
-- payment_method_id is Stax's own opaque vault reference (the actual PAN
-- lives in Stax/BlockChyp's vault, never ours), and card_last_four /
-- card_brand are the two fields PCI DSS explicitly permits a merchant to
-- store outside a validated cardholder-data environment because they
-- cannot be used to reconstruct a card number. This is the same SAQ-A
-- posture the rest of the Stax/Anet integration already holds — a saved
-- card does not widen that.
--
-- One saved card per family (not per parent slot) since the invoice is a
-- family-level bill regardless of which parent pays it.

ALTER TABLE families
    ADD COLUMN IF NOT EXISTS stax_default_payment_method_id TEXT,
    ADD COLUMN IF NOT EXISTS stax_default_card_last_four TEXT,
    ADD COLUMN IF NOT EXISTS stax_default_card_brand TEXT;

-- ============================================================
-- VERIFY (run after applying)
-- ============================================================
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'families'
--      AND column_name LIKE 'stax_default_%';
--   -> three columns present.
--
--   SELECT has_column_privilege('anon', 'families', 'stax_default_payment_method_id', 'SELECT');
--   -> should be false, same as stax_customer_id -- anon's grant on
--      families is an explicit column allow-list (see R3 in CLAUDE.md) and
--      these three must never be added to it. Only the service role
--      (create-stax-charge / charge-stax-payment) reads or writes them.
-- ============================================================
