-- campaign_email_logs
-- Tracks individual emails sent for idempotency
-- Prevents duplicate emails when campaigns are retried or processed multiple times

CREATE TABLE IF NOT EXISTS campaign_email_logs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_email   text        NOT NULL,
  business_id     text        NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  status          text        NOT NULL DEFAULT 'sent'
                             CHECK (status IN ('sent', 'failed', 'bounced')),
  error_message   text,
  UNIQUE(campaign_id, contact_email)
);

CREATE INDEX IF NOT EXISTS idx_campaign_email_logs_campaign_id
  ON campaign_email_logs (campaign_id);

CREATE INDEX IF NOT EXISTS idx_campaign_email_logs_contact_email
  ON campaign_email_logs (contact_email);

CREATE INDEX IF NOT EXISTS idx_campaign_email_logs_campaign_email
  ON campaign_email_logs (campaign_id, contact_email);
