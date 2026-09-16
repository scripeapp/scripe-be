-- ============================================================
-- PHASE 3: Fraud Detection Signals
-- ============================================================

CREATE TABLE IF NOT EXISTS public.fraud_signals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('user', 'business', 'transaction')),
  entity_id     TEXT NOT NULL,
  signal_type   TEXT NOT NULL,
  description   TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'low'
                CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'investigating', 'confirmed', 'cleared')),
  metadata      JSONB DEFAULT '{}',
  reviewed_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  review_notes  TEXT,
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fraud_entity ON public.fraud_signals(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_fraud_status ON public.fraud_signals(status);
CREATE INDEX IF NOT EXISTS idx_fraud_severity ON public.fraud_signals(severity);
CREATE INDEX IF NOT EXISTS idx_fraud_created ON public.fraud_signals(created_at DESC);

-- RLS: service role only
ALTER TABLE public.fraud_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_fraud" ON public.fraud_signals
  USING (auth.role() = 'service_role');

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_fraud_signals_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fraud_signals_updated_at
  BEFORE UPDATE ON public.fraud_signals
  FOR EACH ROW EXECUTE FUNCTION update_fraud_signals_updated_at();
