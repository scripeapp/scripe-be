-- ============================================================
-- PHASE 3: KYC / Business Verification
-- ============================================================

CREATE TABLE IF NOT EXISTS public.kyc_verifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
  document_type     TEXT NOT NULL
                    CHECK (document_type IN ('cac', 'nin', 'bvn', 'utility_bill', 'id_card', 'passport')),
  document_number   TEXT,
  document_url      TEXT,
  metadata          JSONB DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('not_submitted', 'pending', 'approved', 'rejected', 'expired')),
  rejection_reason  TEXT,
  reviewed_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at       TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kyc_business ON public.kyc_verifications(business_id);
CREATE INDEX IF NOT EXISTS idx_kyc_status ON public.kyc_verifications(status);
CREATE INDEX IF NOT EXISTS idx_kyc_type ON public.kyc_verifications(document_type);

-- Add is_verified flag to businesses if it doesn't exist
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;

-- RLS: service role only
ALTER TABLE public.kyc_verifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_kyc" ON public.kyc_verifications
  USING (auth.role() = 'service_role');

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_kyc_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER kyc_updated_at
  BEFORE UPDATE ON public.kyc_verifications
  FOR EACH ROW EXECUTE FUNCTION update_kyc_updated_at();
