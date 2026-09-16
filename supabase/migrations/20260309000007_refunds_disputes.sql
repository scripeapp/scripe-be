-- ============================================================
-- PHASE 3: Refund Requests & Disputes
-- ============================================================

-- Refund requests table
CREATE TABLE IF NOT EXISTS public.refund_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  transaction_id  TEXT,
  amount_ngn      NUMERIC(12, 2) NOT NULL DEFAULT 0,
  reason          TEXT NOT NULL,
  notes           TEXT,
  admin_notes     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'processed', 'failed')),
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refund_requests_status ON public.refund_requests(status);
CREATE INDEX IF NOT EXISTS idx_refund_requests_business ON public.refund_requests(business_id);
CREATE INDEX IF NOT EXISTS idx_refund_requests_created ON public.refund_requests(created_at DESC);

-- Disputes table
CREATE TABLE IF NOT EXISTS public.disputes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  transaction_id  TEXT,
  refund_id       UUID REFERENCES public.refund_requests(id) ON DELETE SET NULL,
  subject         TEXT NOT NULL,
  description     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'investigating', 'resolved', 'closed')),
  resolution      TEXT,
  raised_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disputes_status ON public.disputes(status);
CREATE INDEX IF NOT EXISTS idx_disputes_business ON public.disputes(business_id);

-- RLS: service role only
ALTER TABLE public.refund_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_refunds" ON public.refund_requests
  USING (auth.role() = 'service_role');

ALTER TABLE public.disputes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_disputes" ON public.disputes
  USING (auth.role() = 'service_role');

-- Updated_at triggers
CREATE OR REPLACE FUNCTION update_refund_requests_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER refund_requests_updated_at
  BEFORE UPDATE ON public.refund_requests
  FOR EACH ROW EXECUTE FUNCTION update_refund_requests_updated_at();

CREATE OR REPLACE FUNCTION update_disputes_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER disputes_updated_at
  BEFORE UPDATE ON public.disputes
  FOR EACH ROW EXECUTE FUNCTION update_disputes_updated_at();
