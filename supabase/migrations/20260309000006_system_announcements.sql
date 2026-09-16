-- Migration: 20260309000006_system_announcements.sql
-- Description: Platform-wide system announcements from admin to users

CREATE TABLE IF NOT EXISTS system_announcements (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT        NOT NULL,
  body        TEXT        NOT NULL,
  type        TEXT        NOT NULL DEFAULT 'info'
                          CHECK (type IN ('info', 'warning', 'feature', 'maintenance', 'changelog')),
  audience    TEXT        NOT NULL DEFAULT 'all'
                          CHECK (audience IN ('all', 'pro', 'plus', 'starter', 'paid')),
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  starts_at   TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ,
  created_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_announcements_active   ON system_announcements(is_active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_announcements_audience ON system_announcements(audience);
CREATE INDEX IF NOT EXISTS idx_announcements_expires  ON system_announcements(expires_at) WHERE is_active = true;

ALTER TABLE system_announcements ENABLE ROW LEVEL SECURITY;

-- Admins (service role) can do everything
CREATE POLICY "service_role_all" ON system_announcements
  FOR ALL USING (auth.role() = 'service_role');

-- Authenticated users can read active announcements for their audience
CREATE POLICY "users_read_active" ON system_announcements
  FOR SELECT USING (
    auth.role() = 'authenticated'
    AND is_active = true
    AND (starts_at IS NULL OR starts_at <= NOW())
    AND (expires_at IS NULL OR expires_at >= NOW())
  );
