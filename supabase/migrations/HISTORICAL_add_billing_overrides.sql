-- Per-child per-month billing override amounts
-- Allows admins to manually set a child's billed amount, overriding the calculated value.

CREATE TABLE IF NOT EXISTS billing_overrides (
    id              BIGSERIAL       PRIMARY KEY,
    month           CHAR(7)         NOT NULL,       -- 'YYYY-MM'
    parent_email    TEXT            NOT NULL,
    child_name      TEXT            NOT NULL,
    override_amount NUMERIC(10,2)   NOT NULL,
    created_at      TIMESTAMPTZ     DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     DEFAULT NOW(),
    UNIQUE (month, parent_email, child_name)
);

ALTER TABLE billing_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access to billing_overrides"
    ON billing_overrides FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);
