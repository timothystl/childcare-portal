# Operations

The only deployment workflow is `.github/workflows/auto-merge-claude.yml`. A push to `claude/**`
runs Node 20 tests, rebuilds and checks `dist/`, merges into `main`, and deploys the production
Worker. Never use that branch prefix for tentative work. An ordinary review PR is the safe review
path, but merging production changes still requires explicit approval.

Database migrations and Edge Function releases are separate from the Worker workflow. Verify the
target project, live migration ledger, required objects, function gateway posture, and release
order before deploying dependent code. Do not use a blanket database push to resolve historical
ledger drift.

Monitoring begins with GitHub Actions, Cloudflare Worker logs, Supabase database/function logs and
advisors, scheduled-job history, and Stax webhook/reconciliation state. Scheduled jobs use the
scoped credential and ownership procedure in [SCHEDULED-JOB-OPERATIONS.md](SCHEDULED-JOB-OPERATIONS.md).

Worker rollback uses a known-good Cloudflare deployment or reviewed source redeployment. Edge
Functions require redeploying protected source. Database recovery requires a planned backup/PITR
or logical restore; Storage objects require separate recovery because database backups contain
metadata rather than the object bytes. No complete disposable myMDO recovery pass is claimed here.
