-- Track per-child annual registration fee payment year
ALTER TABLE students ADD COLUMN IF NOT EXISTS reg_fee_paid_year INTEGER;
COMMENT ON COLUMN students.reg_fee_paid_year IS 'Year the annual registration/enrollment fee was paid (null = unpaid)';
