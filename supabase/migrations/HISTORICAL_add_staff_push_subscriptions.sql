-- Staff push notification subscriptions (VAPID / Web Push)
CREATE TABLE IF NOT EXISTS staff_push_subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id   uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  endpoint   text NOT NULL,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(staff_id, endpoint)
);

ALTER TABLE staff_push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Only accessible via service role (edge functions / worker)
CREATE POLICY "service role only"
  ON staff_push_subscriptions
  USING (false)
  WITH CHECK (false);
