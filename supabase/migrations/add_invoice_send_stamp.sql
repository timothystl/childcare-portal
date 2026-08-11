-- ============================================================
-- INVOICE SEND STAMP
-- ============================================================
-- The portal could already compute what to charge and record what was
-- paid, but nothing marked a bill as *issued* — every one of the 496
-- rows in billing_invoices sat at status='draft' forever, because the
-- draft → finalized path had no UI attached to it.
--
-- The Invoices tool closes that gap. It needs to record two things the
-- table could not hold:
--   sent_at  — when the bill went to the family. Accounts Receivable
--              ages from this, not from the start of the month, so a
--              bill issued on the 20th is not "20 days overdue".
--   sent_to  — the address it went to, kept so a later bounce or a
--              changed email can be traced to what was actually used.
--
-- Additive and reversible: no existing column changes, no backfill.
-- `status` gains 'sent' alongside the existing draft/finalized/paid/
-- partial values already in use by admin-billing.js.
--
-- Apply by hand in the Supabase SQL Editor — supabase/migrations/ is
-- NOT auto-applied.
-- ============================================================

ALTER TABLE public.billing_invoices
    ADD COLUMN IF NOT EXISTS sent_at timestamptz,
    ADD COLUMN IF NOT EXISTS sent_to text;

-- Accounts Receivable and the Invoices list both filter on "issued but
-- not paid", which is a scan over sent_at within a cycle.
CREATE INDEX IF NOT EXISTS billing_invoices_sent_idx
    ON public.billing_invoices (cycle_id, sent_at);

COMMENT ON COLUMN public.billing_invoices.sent_at IS
    'When the invoice was issued to the family. Overdue ages from here, not from the month start. NULL = still a draft.';
COMMENT ON COLUMN public.billing_invoices.sent_to IS
    'The address the invoice was issued to, as of the send.';

-- ============================================================
-- VERIFY (run after applying)
-- ============================================================
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'billing_invoices' AND column_name IN ('sent_at','sent_to');
--   → expect two rows.
--
--   SELECT status, count(*), count(sent_at) AS stamped
--     FROM billing_invoices GROUP BY status;
--   → every pre-existing row keeps its status with stamped = 0.
-- ============================================================
