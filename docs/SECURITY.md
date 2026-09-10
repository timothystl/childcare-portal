# Security

myMDO contains live child, family, staff, wage, billing, and payment data. Authorization is
server-enforced through RLS, grants, RPCs, Edge Functions, or the Worker; UI hiding is never enough.
Parents are scoped to their own family. Staff PIN routes are task-specific, rate-limited, and
fail closed. Never trust client-supplied family, staff, amount, recipient, or role claims when the
server can derive them.

Every exposed-schema table requires deliberate grants plus row-level policies matching the actual
access model. `TO authenticated` alone is authentication, not ownership authorization. Privileged
functions require fixed safe search paths, explicit caller checks, and revoked default `PUBLIC`
execution before narrow grants. Views and Storage policies require the same deliberate review.

The browser may contain the Supabase publishable/legacy anon key. It must never contain a service
role/secret key, Stax credential, cron secret, or private integration key. Managed secret stores
hold those values; docs record names and owners only.

Stax is the sole active payment provider. Payment functions authenticate, re-fetch provider state,
remain idempotent, and record authoritative results server-side. Authentication, RLS, billing,
payment, migration, scheduled-job, and Storage changes require focused negative-path verification
and explicit production approval.
