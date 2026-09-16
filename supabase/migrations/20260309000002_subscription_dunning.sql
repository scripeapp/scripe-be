-- Migration: 20260309000002_subscription_dunning.sql
-- Description: Dunning table for tracking failed subscription payment retries

CREATE TABLE IF NOT EXISTS subscription_dunning (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  subscription_plan TEXT       NOT NULL,
  failure_reason   TEXT,
  attempt_count    INTEGER     NOT NULL DEFAULT 0,
  first_failed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at  TIMESTAMPTZ,
  next_retry_at    TIMESTAMPTZ,
  resolved_at      TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ,
  status           TEXT        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'resolved', 'cancelled')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dunning_business_id  ON subscription_dunning(business_id);
CREATE INDEX IF NOT EXISTS idx_dunning_status       ON subscription_dunning(status);
CREATE INDEX IF NOT EXISTS idx_dunning_next_retry   ON subscription_dunning(next_retry_at)
  WHERE status = 'active';

-- Only service role can read/write dunning records (admin dashboard uses service role)
ALTER TABLE subscription_dunning ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON subscription_dunning
  FOR ALL USING (auth.role() = 'service_role');
