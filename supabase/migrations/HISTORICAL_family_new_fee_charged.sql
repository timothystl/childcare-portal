-- One-time "new family" enrollment fee tracking.
-- New rows default to false (not yet charged, so a brand-new family gets
-- charged on their first billing report). Existing families are backfilled
-- to true so they are never retroactively charged this fee.
alter table families
  add column if not exists new_family_fee_charged boolean not null default false;

update families
set new_family_fee_charged = true
where new_family_fee_charged = false;
