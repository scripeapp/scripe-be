-- Migration: 20260309000003_plan_upgrade_signals.sql
-- Description: Tracks when businesses hit plan limits — upsell opportunity signals

CREATE TABLE IF NOT EXISTS plan_upgrade_signals (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  resource       TEXT        NOT NULL,
  current_plan   TEXT        NOT NULL,
  limit_value    INTEGER     NOT NULL,
  used_value     INTEGER     NOT NULL,
  hit_count      INTEGER     NOT NULL DEFAULT 1,
  first_hit_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_hit_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(business_id, resource, current_plan)
);

CREATE INDEX IF NOT EXISTS idx_upgrade_signals_business   ON plan_upgrade_signals(business_id);
CREATE INDEX IF NOT EXISTS idx_upgrade_signals_resource   ON plan_upgrade_signals(resource);
CREATE INDEX IF NOT EXISTS idx_upgrade_signals_plan       ON plan_upgrade_signals(current_plan);
CREATE INDEX IF NOT EXISTS idx_upgrade_signals_unresolved ON plan_upgrade_signals(hit_count DESC)
  WHERE resolved_at IS NULL;

ALTER TABLE plan_upgrade_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON plan_upgrade_signals
  FOR ALL USING (auth.role() = 'service_role');
