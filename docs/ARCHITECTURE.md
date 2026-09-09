# Architecture

myMDO is one product spanning public childcare information, registration, family/parent access,
classrooms, staff operations, attendance, schedules, billing/payments, messaging, and approved MDO
payroll inputs.

Cloudflare Worker `childcare-portal` starts at `worker.js` and serves committed static assets. The
source JavaScript lives under `js/`; production serves generated committed bundles under `dist/`.
`wrangler.jsonc` routes only `/` and `/index.html` through the Worker before static assets so the
server-rendered home page and response controls run without charging every asset request.

Supabase project `dahdstopsumxnqvdclmy` owns Postgres, Auth, Storage, Edge Functions, and scheduled
jobs. Migrations under `supabase/migrations/` are source records but are not automatically applied
by the GitHub workflow. Edge gateway JWT posture is declared in `supabase/config.toml`; functions
that disable gateway verification must implement their own explicit authentication.

The public hostname is `mdo.timothystl.org`. A future repository rename is a separate
non-functional change, not part of ordinary feature work.
