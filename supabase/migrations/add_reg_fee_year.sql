-- Track which year the annual registration/enrollment fee was paid per child.
-- null = not paid this year; set to the 4-digit year when marked paid by admin.
ALTER TABLE students ADD COLUMN IF NOT EXISTS reg_fee_paid_year INTEGER;
