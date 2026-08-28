-- Messages & Settings consolidation (design handoff, 2026-08-26)
-- Adds the "needs an email" flag + "replied by email" tracker to the
-- Contact Us inbox (`messages`), used by the new unified Messages screen.
--
-- ⚠️ Scoped to `messages` ONLY. Family threads (`message_threads` /
-- `message_items`) are two-way in-app already and don't need an email
-- escape hatch — see the Messages screen README. Do not add these columns
-- to message_threads.
alter table messages
    add column if not exists needs_email_followup boolean not null default false,
    add column if not exists replied_by_email      boolean not null default false,
    add column if not exists replied_by_email_at   timestamptz;
