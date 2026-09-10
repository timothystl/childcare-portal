# Timothy Lutheran myMDO

myMDO is Timothy Lutheran Church's operated childcare platform for public program information,
registration, family and parent access, classrooms, staff clock-in and schedules, attendance,
billing, payments, messaging, and MDO payroll inputs.

This is not a starter project. Do not follow historical setup instructions to recreate its
database, authentication, RLS policies, or client-side access model.

## For developers and AI agents

Read [`AGENTS.md`](AGENTS.md). It is the sole current implementation and safety instruction file.
Other Markdown files are task-specific manuals, historical reviews, research, and migration
records. They are not parallel sources of current architecture.

Current references:

- [Architecture](docs/ARCHITECTURE.md)
- [Data ownership](docs/DATA-OWNERSHIP.md)
- [Operations](docs/OPERATIONS.md)
- [Security](docs/SECURITY.md)
- [Testing](docs/TESTING.md)

## Current runtime

- Cloudflare Worker and static assets: `worker.js` with `wrangler.jsonc`
- Production hostname: `mdo.timothystl.org`
- Supabase project: `dahdstopsumxnqvdclmy`
- Source JavaScript: `js/`
- Generated committed bundles: `dist/`
- Database and security changes: `supabase/migrations/`
- Edge Functions: `supabase/functions/`

## Local verification

Use Node 20:

```bash
npm ci
npm test
npm run build
git diff --exit-code -- dist
```

Migrations are not automatically applied by the repository workflow. Never deploy code that
depends on a migration until the target environment has been verified and the migration has been
applied in the approved order.

## Release warning

The current `claude/**` workflow automatically tests, merges to `main`, and deploys. Do not use a
`claude/**` branch for tentative work. Use an ordinary review branch and obtain explicit approval
before merging any production change.
