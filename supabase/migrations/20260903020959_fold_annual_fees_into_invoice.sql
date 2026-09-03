-- No-op. Applied by mistake — a placeholder comment was sent to apply_migration
-- instead of the real SQL. The actual fix is the very next migration,
-- 20260903021033_fold_annual_fees_into_invoice_real.sql. Left here (rather than
-- deleted) so the committed migration history matches exactly what was applied,
-- per this repo's own standing rule.
select 1;
