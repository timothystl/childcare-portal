-- push_subscriptions: browser Web Push subscriptions linked to families.
-- One row per device per family; automatically cleaned up on unsubscribe (410 Gone).

create table if not exists push_subscriptions (
  id         uuid        primary key default gen_random_uuid(),
  family_id  uuid        not null references families(id) on delete cascade,
  endpoint   text        not null,
  p256dh     text        not null,  -- browser public key (base64url)
  auth       text        not null,  -- browser auth secret (base64url)
  created_at timestamptz not null default now(),
  -- one subscription per device per family
  unique (family_id, endpoint)
);

create index if not exists push_subscriptions_family_idx
  on push_subscriptions(family_id);

-- Only the service role (Cloudflare Worker) can read/write these.
-- Parents never query this table directly.
alter table push_subscriptions enable row level security;

create policy "service role only"
  on push_subscriptions
  using (false)
  with check (false);
