-- ============================================================
-- PHASE 4: Customer Health Scores
-- ============================================================

CREATE TABLE IF NOT EXISTS public.business_health_scores (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID UNIQUE REFERENCES public.businesses(id) ON DELETE CASCADE,
  score           INTEGER NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  tier            TEXT NOT NULL DEFAULT 'critical'
                  CHECK (tier IN ('champion', 'healthy', 'at_risk', 'critical')),
  factors         JSONB DEFAULT '{}',
  computed_at     TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_health_scores_tier ON public.business_health_scores(tier);
CREATE INDEX IF NOT EXISTS idx_health_scores_score ON public.business_health_scores(score);

ALTER TABLE public.business_health_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_health" ON public.business_health_scores
  USING (auth.role() = 'service_role');

-- Add last_login_at to businesses if not present
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION update_health_scores_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER health_scores_updated_at
  BEFORE UPDATE ON public.business_health_scores
  FOR EACH ROW EXECUTE FUNCTION update_health_scores_updated_at();
