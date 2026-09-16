-- Migration: 20260309000005_webhook_logs.sql
-- Description: Webhook event logging for visibility and debugging

CREATE TABLE IF NOT EXISTS webhook_logs (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  direction           TEXT        NOT NULL DEFAULT 'inbound'
                                  CHECK (direction IN ('inbound', 'outbound')),
  source              TEXT        NOT NULL,
  event_type          TEXT        NOT NULL,
  reference           TEXT,
  business_id         UUID        REFERENCES businesses(id) ON DELETE SET NULL,
  status              TEXT        NOT NULL
                                  CHECK (status IN ('received', 'processed', 'failed', 'ignored')),
  payload             JSONB       NOT NULL DEFAULT '{}',
  error_message       TEXT,
  processing_time_ms  INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_source     ON webhook_logs(source);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_event_type ON webhook_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_status     ON webhook_logs(status);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_business   ON webhook_logs(business_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_created_at ON webhook_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_reference  ON webhook_logs(reference);

ALTER TABLE webhook_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON webhook_logs FOR ALL USING (auth.role() = 'service_role');
