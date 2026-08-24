-- Read-only checks to run after 20260824_billing_invoice_integrity.sql.
-- Every result set should be empty unless the comment says otherwise.

-- 1. No more than one original invoice per family/month.
SELECT bc.month, bi.family_id, count(*) AS original_count
  FROM billing_invoices bi
  JOIN billing_cycles bc ON bc.id = bi.cycle_id
 WHERE COALESCE(bi.invoice_type, 'original') = 'original'
 GROUP BY bc.month, bi.family_id
HAVING count(*) > 1;

-- 2. No more than one pending adjustment per family/month.
SELECT bc.month, bi.family_id, count(*) AS draft_adjustment_count
  FROM billing_invoices bi
  JOIN billing_cycles bc ON bc.id = bi.cycle_id
 WHERE bi.invoice_type = 'adjustment' AND bi.status = 'draft'
 GROUP BY bc.month, bi.family_id
HAVING count(*) > 1;

-- 3. Draft originals whose amount differs from the authoritative calculator.
SELECT bc.month, f.parent_name, f.parent_email,
       bi.id AS invoice_id, bi.final_amount AS stored_amount,
       calc.final AS calculated_amount,
       round(bi.final_amount - calc.final, 2) AS difference
  FROM billing_invoices bi
  JOIN billing_cycles bc ON bc.id = bi.cycle_id
  JOIN families f ON f.id = bi.family_id
 CROSS JOIN LATERAL compute_family_month_charges(bi.family_id, bc.month) calc
 WHERE bi.status = 'draft'
   AND COALESCE(bi.invoice_type, 'original') = 'original'
   AND abs(bi.final_amount - calc.final) > 0.01
 ORDER BY abs(bi.final_amount - calc.final) DESC;

-- 4. Nonzero drafts for families whose current authoritative charge is zero.
SELECT bc.month, f.parent_name, f.parent_email, bi.id, bi.final_amount
  FROM billing_invoices bi
  JOIN billing_cycles bc ON bc.id = bi.cycle_id
  JOIN families f ON f.id = bi.family_id
 CROSS JOIN LATERAL compute_family_month_charges(bi.family_id, bc.month) calc
 WHERE bi.status = 'draft'
   AND COALESCE(bi.invoice_type, 'original') = 'original'
   AND calc.base = 0 AND calc.final = 0
   AND bi.final_amount <> 0;

-- 5. Informational status inventory. Review unexpected spellings manually.
SELECT status, COALESCE(invoice_type, 'original') AS invoice_type, count(*)
  FROM billing_invoices
 GROUP BY status, COALESCE(invoice_type, 'original')
 ORDER BY status, invoice_type;

-- 6. Imported/finalized invoices that already have draft adjustments.
-- These can be legitimate after a schedule change, but should be reviewed.
SELECT bc.month, f.parent_name, original.id AS original_id,
       original.final_amount AS imported_amount,
       adjustment.id AS adjustment_id,
       adjustment.final_amount AS adjustment_amount
  FROM billing_invoices original
  JOIN billing_cycles bc ON bc.id = original.cycle_id
  JOIN families f ON f.id = original.family_id
  JOIN billing_invoices adjustment
    ON adjustment.cycle_id = original.cycle_id
   AND adjustment.family_id = original.family_id
   AND adjustment.invoice_type = 'adjustment'
   AND adjustment.status = 'draft'
 WHERE original.invoice_type = 'original'
   AND original.status = 'finalized'
 ORDER BY bc.month, f.parent_name;
