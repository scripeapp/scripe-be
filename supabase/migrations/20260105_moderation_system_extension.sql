-- ============================================================================
-- Moderation System Schema Extensions
-- ============================================================================

-- 1. Add moderation columns to content tables
-- This allows us to track the status of content across the platform
ALTER TABLE stores ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(20) DEFAULT 'approved' CHECK (moderation_status IN ('pending', 'approved', 'rejected', 'flagged'));
ALTER TABLE stores ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS moderated_by UUID;

ALTER TABLE products ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(20) DEFAULT 'approved' CHECK (moderation_status IN ('pending', 'approved', 'rejected', 'flagged'));
ALTER TABLE products ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS moderated_by UUID;

ALTER TABLE events ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(20) DEFAULT 'approved' CHECK (moderation_status IN ('pending', 'approved', 'rejected', 'flagged'));
ALTER TABLE events ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS moderated_by UUID;

ALTER TABLE publications ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(20) DEFAULT 'approved' CHECK (moderation_status IN ('pending', 'approved', 'rejected', 'flagged'));
ALTER TABLE publications ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS moderated_by UUID;

ALTER TABLE posts ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(20) DEFAULT 'approved' CHECK (moderation_status IN ('pending', 'approved', 'rejected', 'flagged'));
ALTER TABLE posts ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS moderated_by UUID;

-- 2. Moderation Reports Table
-- Stores user reports against content
CREATE TABLE IF NOT EXISTS moderation_reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_id UUID REFERENCES public.users(id),
  target_type VARCHAR(50) NOT NULL, -- 'post', 'product', 'event', 'store', 'user'
  target_id UUID NOT NULL,
  reason VARCHAR(100) NOT NULL, -- 'spam', 'inappropriate', 'fraud', 'other'
  description TEXT,
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  admin_notes TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES admin_users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_moderation_reports_target ON moderation_reports(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_moderation_reports_status ON moderation_reports(status);

-- 3. Moderation Queue View
-- Provides a unified view for admins to see what needs review
CREATE OR REPLACE VIEW moderation_queue AS
SELECT 
  id,
  target_type,
  target_id,
  reason,
  description,
  status,
  created_at
FROM moderation_reports
WHERE status = 'open';

-- Trigger for updated_at on moderation_reports
DROP TRIGGER IF EXISTS moderation_reports_set_updated_at ON moderation_reports;
CREATE TRIGGER moderation_reports_set_updated_at
BEFORE UPDATE ON moderation_reports
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
