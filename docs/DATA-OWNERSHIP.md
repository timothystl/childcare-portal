# Data Ownership

myMDO is authoritative for childcare families and children, registration, room placement,
attendance, schedules, staff operational records, childcare credentials, billing/invoices,
payments, messages, incidents, Storage objects, and MDO payroll inputs/approval.

Parents access only their own family/child records. Classroom staff use task-specific PIN-gated
workflows. The restricted administrator handles enumerated daily operations; full administration
retains billing, payroll, users/roles, audit, sensitive staff records, and policy controls.

Finance may receive narrow approved payroll/finance summaries but does not own raw childcare
billing, family, clock, or schedule records. Church HR owns the church employment relationship;
Finance is the target owner of payroll processing. A consumer does not become an authoritative
writer merely because it displays a summary.

Cross-product interfaces must identify schema/version, authorization, idempotency, failure
behavior, reconciliation, and rollback. Never expose unrestricted Supabase tables to another
product as an integration shortcut.
