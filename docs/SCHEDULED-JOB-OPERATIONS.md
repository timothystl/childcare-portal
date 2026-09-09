# Scheduled-job operations

The myMDO scheduled Edge Functions are owned by Andrew Dinger. They use one
purpose-specific `CRON_SECRET`; pg_cron reads the matching value from Supabase
Vault (`mymdo_cron_secret`). The scheduled request must not contain a service
role JWT.

## Release and rotation

1. Generate a high-entropy value without printing or committing it.
2. Save it as the Edge Function secret `CRON_SECRET` and as the Vault secret
   named `mymdo_cron_secret`.
3. Deploy all five scheduled functions with the repository `config.toml`.
4. Apply `20260909030842_scope_scheduled_job_credentials.sql`.
5. Verify the five named jobs in `cron.job`; their command text must reference
   Vault and must not contain an Authorization bearer value.
6. Invoke each job through `cron.schedule`/`pg_net`, then inspect HTTP outcomes.
   Do not manually invoke payment reconciliation against live payment data.

Rotate by updating both secret stores, redeploying the functions, and then
triggering one non-payment job. Keep the old value only for the shortest overlap
needed to complete the coordinated change.

## Last success and failure visibility

`pg_net` retains the request outcome in `net._http_response`. Join its `id` to
the request id returned by `net.http_post`, or inspect recent responses by
creation time and status code in the Supabase SQL editor. A `2xx` means the
function completed all of its work; partial push, email, storage, or dedupe
failures now return `502` instead of reporting success.

Review recent non-2xx responses after every release and at least weekly. For a
non-2xx result, inspect the Edge Function logs by function and timestamp. Logs
must contain identifiers/counts only—never message bodies, family details,
credentials, photo paths, or payment data.

## Retry boundaries

- Clock checks retry naturally at the next 15-minute run; dedupe state is only
  written after required notifications succeed.
- Waitlist reminder state advances only after provider-confirmed delivery, so a
  failed candidate is retried on the next weekly run.
- Daily summaries retry on the next scheduled day; operators may manually run
  the job sooner after correcting the delivery dependency.
- Photo cleanup reports failed object deletions as `502`; rows are already
  removed, so investigate orphan cleanup rather than blindly repeating it.
- Stax reconciliation runs every 30 minutes. Never retry it manually without
  following the payment reconciliation runbook and reviewing current lock state.

The accountable owner must name a backup operator. Review access quarterly,
rotate immediately after suspected disclosure, and remove access immediately
when an operator leaves the duty.
