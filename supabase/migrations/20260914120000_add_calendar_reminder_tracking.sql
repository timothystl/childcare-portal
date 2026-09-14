-- ============================================================
-- CALENDAR REMINDER TRACKING
-- ============================================================
-- Backs send-calendar-reminders: a weekly nudge, starting the 15th of the
-- month, to families who had confirmed non-waitlisted care days last month
-- but haven't yet submitted a confirmed calendar for the current month.
--
-- calendar_reminder_log tracks per-family, per-month reminder state, the
-- same last_reminder_sent_at/reminder_count shape waitlist_applications
-- uses for its own weekly reminder job — but split into its own table
-- rather than columns on families, because "missing this month's calendar"
-- and its reminder count must reset every month: a family capped out in
-- August must be eligible again in September, and families has no natural
-- per-month row to hang that state on. Keyed by (family_id, month_key).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.calendar_reminder_log (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
    month_key    text NOT NULL,
    last_sent_at timestamptz,
    send_count   integer NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (family_id, month_key)
);

ALTER TABLE public.calendar_reminder_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.calendar_reminder_log FROM PUBLIC, anon, authenticated;

-- send-calendar-reminders reads/writes this table on the service-role
-- connection, which bypasses RLS entirely. This policy exists only so an
-- admin can review reminder history from the app/SQL editor without a
-- service-role key, mirroring every other admin-only operational table.
CREATE POLICY "admin all calendar_reminder_log" ON public.calendar_reminder_log
    FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

GRANT SELECT ON TABLE public.calendar_reminder_log TO authenticated;

CREATE INDEX IF NOT EXISTS calendar_reminder_log_month_idx
    ON public.calendar_reminder_log (month_key);

-- calendar_reminder_notify settings key (remindersEnabled / notifyEmail),
-- same shape as waitlist_notify, is written/read via the ordinary
-- admin_all_settings policy already covering every settings key — it is
-- deliberately NOT added to the anon "public read allowed keys" allow-list
-- in policy_scoping_stage3to5_remaining_tables.sql, so it stays admin-only,
-- off by default, same as waitlist_notify.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'mymdo_cron_secret'
  ) THEN
    RAISE EXCEPTION 'Vault secret mymdo_cron_secret must exist before this migration is applied';
  END IF;
END
$$;

SELECT cron.schedule('send-calendar-reminders', '0 14 * * *', $job$
  SELECT net.http_post(
    url := 'https://dahdstopsumxnqvdclmy.supabase.co/functions/v1/send-calendar-reminders',
    headers := jsonb_build_object(
      'X-Cron-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'mymdo_cron_secret'),
      'Content-Type', 'application/json'
    ), body := '{}'::jsonb
  )
$job$);
