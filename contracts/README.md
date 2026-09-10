# Cross-product contracts

This directory contains proposed, versioned myMDO producer contracts, synthetic examples, and
their validation tests. A schema merge does not deploy an Edge Function, authorize a consumer,
copy production data, or approve production traffic.

## `mymdo.finance-summary.v1`

myMDO remains authoritative for childcare billing, staff clocks/hours, schedules, wages, payments,
and approved payroll inputs. Finance may consume only the restricted monthly aggregates defined in
`mymdo-finance-summary-v1.schema.json`.

The proposed contract deliberately excludes person, family, child, and staff identifiers; contact
information; wage rates; clock records; invoice/payment identifiers; and bank/payment details.
Payroll actuals are labeled `trend-estimate` because the current calculation is not a payroll
register. Annual settings prorated to months are labeled `annual-budget-proration`.

Before runtime implementation, separately review transport authentication, credential rotation,
authorization, freshness, retries, reconciliation, failure behavior, consumer rejection of invalid
versions/classifications, observability, rollback, and deprecation. Production enablement requires
an explicit release approval.
