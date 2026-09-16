-- Migration: 20260309000004_admin_alerts.sql
-- Description: Admin real-time alerts table

CREATE TABLE IF NOT EXISTS admin_alerts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type        TEXT        NOT NULL,
  severity    TEXT        NOT NULL DEFAULT 'info'
                          CHECK (severity IN ('info', 'warning', 'critical')),
  title       TEXT        NOT NULL,
  message     TEXT        NOT NULL,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  is_read     BOOLEAN     NOT NULL DEFAULT false,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_alerts_is_read    ON admin_alerts(is_read);
CREATE INDEX IF NOT EXISTS idx_admin_alerts_severity   ON admin_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_admin_alerts_type       ON admin_alerts(type);
CREATE INDEX IF NOT EXISTS idx_admin_alerts_created_at ON admin_alerts(created_at DESC);

ALTER TABLE admin_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON admin_alerts FOR ALL USING (auth.role() = 'service_role');
