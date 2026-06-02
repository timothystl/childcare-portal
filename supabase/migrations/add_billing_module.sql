-- ============================================================
-- BILLING MODULE  v1.11.0
-- ============================================================

-- Invoices are generated from each family's registered care days
-- (via the existing billing calculation), not from a separate rate table.

-- ── 1. billing_cycles ────────────────────────────────────────
-- One row per billing period (month). Status flows: 'open' → 'closed'.
CREATE TABLE IF NOT EXISTS billing_cycles (
    id          BIGSERIAL   PRIMARY KEY,
    month       CHAR(7)     NOT NULL UNIQUE, -- 'YYYY-MM'
    status      TEXT        NOT NULL DEFAULT 'open', -- 'open'|'closed'
    opened_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at   TIMESTAMPTZ,
    closed_by   TEXT,
    notes       TEXT
);

ALTER TABLE billing_cycles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth access" ON billing_cycles
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- ── 3. billing_invoices ──────────────────────────────────────
-- One per family per cycle. Generated as 'draft', locked when cycle closes.
CREATE TABLE IF NOT EXISTS billing_invoices (
    id                BIGSERIAL       PRIMARY KEY,
    cycle_id          BIGINT          NOT NULL REFERENCES billing_cycles(id) ON DELETE RESTRICT,
    family_id         UUID            NOT NULL REFERENCES families(id) ON DELETE RESTRICT,
    base_amount       NUMERIC(10,2)   NOT NULL DEFAULT 0,
    discount_amount   NUMERIC(10,2)   NOT NULL DEFAULT 0,
    adjustment_amount NUMERIC(10,2)   NOT NULL DEFAULT 0, -- positive=surcharge, negative=credit
    adjustment_note   TEXT,
    final_amount      NUMERIC(10,2)   NOT NULL DEFAULT 0, -- base - discount + adjustment
    status            TEXT            NOT NULL DEFAULT 'draft', -- 'draft'|'finalized'|'paid'|'partial'
    generated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    finalized_at      TIMESTAMPTZ,
    UNIQUE (cycle_id, family_id)
);

CREATE INDEX IF NOT EXISTS billing_invoices_cycle_idx   ON billing_invoices (cycle_id);
CREATE INDEX IF NOT EXISTS billing_invoices_family_idx  ON billing_invoices (family_id);
CREATE INDEX IF NOT EXISTS billing_invoices_status_idx  ON billing_invoices (status);

ALTER TABLE billing_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth access" ON billing_invoices
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- ── 4. billing_import_batches ────────────────────────────────
-- Audit trail for Procare CSV uploads. Created before payments so FK works.
CREATE TABLE IF NOT EXISTS billing_import_batches (
    id            BIGSERIAL   PRIMARY KEY,
    imported_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    imported_by   TEXT        NOT NULL,
    filename      TEXT        NOT NULL,
    row_count     INT         NOT NULL DEFAULT 0,
    matched_count INT         NOT NULL DEFAULT 0,
    skipped_count INT         NOT NULL DEFAULT 0,
    notes         TEXT
);

ALTER TABLE billing_import_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth access" ON billing_import_batches
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- ── 5. billing_payments ──────────────────────────────────────
-- Individual payment records. invoice_id is nullable for unlinked payments.
CREATE TABLE IF NOT EXISTS billing_payments (
    id              BIGSERIAL       PRIMARY KEY,
    family_id       UUID            NOT NULL REFERENCES families(id) ON DELETE RESTRICT,
    invoice_id      BIGINT          REFERENCES billing_invoices(id) ON DELETE SET NULL,
    import_batch_id BIGINT          REFERENCES billing_import_batches(id) ON DELETE SET NULL,
    amount          NUMERIC(10,2)   NOT NULL,
    payment_date    DATE            NOT NULL,
    payment_method  TEXT            NOT NULL DEFAULT 'check', -- 'cash'|'check'|'ach'|'card'|'other'
    note            TEXT,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    created_by      TEXT            NOT NULL
);

CREATE INDEX IF NOT EXISTS billing_payments_family_idx   ON billing_payments (family_id);
CREATE INDEX IF NOT EXISTS billing_payments_invoice_idx  ON billing_payments (invoice_id);
CREATE INDEX IF NOT EXISTS billing_payments_batch_idx    ON billing_payments (import_batch_id)
    WHERE import_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS billing_payments_date_idx     ON billing_payments (payment_date DESC);

ALTER TABLE billing_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth access" ON billing_payments
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- ── 6. Extend families table ─────────────────────────────────
ALTER TABLE families
    ADD COLUMN IF NOT EXISTS registration_lock_reason TEXT;
