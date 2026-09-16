-- ============================================================
-- PHASE 4: Feature Flags
-- ============================================================

CREATE TABLE IF NOT EXISTS public.feature_flags (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key                   TEXT UNIQUE NOT NULL,
  name                  TEXT NOT NULL,
  description           TEXT,
  enabled               BOOLEAN NOT NULL DEFAULT FALSE,
  rollout_percentage    INTEGER NOT NULL DEFAULT 0 CHECK (rollout_percentage BETWEEN 0 AND 100),
  allowed_plans         TEXT[] DEFAULT '{}',
  allowed_business_ids  UUID[] DEFAULT '{}',
  metadata              JSONB DEFAULT '{}',
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flags_key ON public.feature_flags(key);
CREATE INDEX IF NOT EXISTS idx_flags_enabled ON public.feature_flags(enabled);

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_flags" ON public.feature_flags
  USING (auth.role() = 'service_role');

-- Allow authenticated users to read enabled flags
CREATE POLICY "read_active_flags" ON public.feature_flags
  FOR SELECT
  USING (auth.role() = 'authenticated' AND enabled = TRUE);

CREATE OR REPLACE FUNCTION update_flags_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER flags_updated_at
  BEFORE UPDATE ON public.feature_flags
  FOR EACH ROW EXECUTE FUNCTION update_flags_updated_at();
