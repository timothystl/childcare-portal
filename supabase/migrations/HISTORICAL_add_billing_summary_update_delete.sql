-- Allow authenticated admin users to UPDATE and DELETE billing_summary rows
-- Required for inline editing and row deletion from the admin dashboard

CREATE POLICY "Admin update billing_summary"
    ON billing_summary FOR UPDATE
    USING (auth.role() = 'authenticated')
    WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Admin delete billing_summary"
    ON billing_summary FOR DELETE
    USING (auth.role() = 'authenticated');
