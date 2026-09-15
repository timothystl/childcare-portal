-- Add source column to billing_import_batches (missing from original schema)
-- Also relax filename/imported_by to allow defaults for older call sites
ALTER TABLE billing_import_batches
    ADD COLUMN IF NOT EXISTS source TEXT,
    ALTER COLUMN filename SET DEFAULT '',
    ALTER COLUMN imported_by SET DEFAULT '';
