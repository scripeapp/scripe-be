-- ============================================================
-- PHASE 4: NPS Feedback
-- ============================================================

CREATE TABLE IF NOT EXISTS public.nps_responses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  business_id  UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  score        INTEGER NOT NULL CHECK (score BETWEEN 0 AND 10),
  category     TEXT NOT NULL CHECK (category IN ('promoter', 'passive', 'detractor')),
  feedback     TEXT,
  survey_type  TEXT DEFAULT 'general',
  metadata     JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nps_category ON public.nps_responses(category);
CREATE INDEX IF NOT EXISTS idx_nps_created ON public.nps_responses(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nps_business ON public.nps_responses(business_id);

ALTER TABLE public.nps_responses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_nps" ON public.nps_responses
  USING (auth.role() = 'service_role');
