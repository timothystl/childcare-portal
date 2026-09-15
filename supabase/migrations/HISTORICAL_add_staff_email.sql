-- Add email column to staff table for schedule email delivery
ALTER TABLE staff ADD COLUMN IF NOT EXISTS email text;
