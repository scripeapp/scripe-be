-- Extend campaign_email_logs to support per-recipient tracking from Plunk webhooks

ALTER TABLE campaign_email_logs
  DROP CONSTRAINT IF EXISTS campaign_email_logs_status_check;

ALTER TABLE campaign_email_logs
  ADD COLUMN IF NOT EXISTS delivered_at    timestamptz,
  ADD COLUMN IF NOT EXISTS opened_at       timestamptz,
  ADD COLUMN IF NOT EXISTS clicked_at      timestamptz,
  ADD COLUMN IF NOT EXISTS bounced_at      timestamptz,
  ADD COLUMN IF NOT EXISTS unsubscribed_at timestamptz;

ALTER TABLE campaign_email_logs
  ADD CONSTRAINT campaign_email_logs_status_check
  CHECK (status IN ('sent', 'delivered', 'opened', 'clicked', 'bounced', 'failed', 'unsubscribed'));

-- Enable RLS and allow business members to read/write their own logs
ALTER TABLE campaign_email_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Business member access" ON campaign_email_logs;
CREATE POLICY "Business member access" ON campaign_email_logs
  FOR ALL
  USING (is_business_member(business_id::uuid));
