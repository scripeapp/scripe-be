-- Store Plunk's email id on each send so tracking webhooks can correlate
-- precisely (event.emailId → campaign_email_logs.plunk_email_id), instead of
-- relying on a best-effort recipient-email match. Plunk delivers hilaq campaign
-- emails as transactional sends (no campaignId / metadata in the webhook), so
-- this id is the only collision-free correlation key.

ALTER TABLE campaign_email_logs
  ADD COLUMN IF NOT EXISTS plunk_email_id text;

CREATE INDEX IF NOT EXISTS idx_campaign_email_logs_plunk_email_id
  ON campaign_email_logs (plunk_email_id);
