-- ============================================================
-- PHASE 3: NDPR Data Requests
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ndpr_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  business_id      UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  request_type     TEXT NOT NULL
                   CHECK (request_type IN ('access', 'deletion', 'portability', 'rectification', 'objection')),
  requester_email  TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'processing', 'completed', 'rejected')),
  admin_notes      TEXT,
  export_url       TEXT,
  processed_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  processed_at     TIMESTAMPTZ,
  due_date         TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ndpr_status ON public.ndpr_requests(status);
CREATE INDEX IF NOT EXISTS idx_ndpr_type ON public.ndpr_requests(request_type);
CREATE INDEX IF NOT EXISTS idx_ndpr_due ON public.ndpr_requests(due_date);
CREATE INDEX IF NOT EXISTS idx_ndpr_user ON public.ndpr_requests(user_id);

-- Add deletion tracking to users if not already present
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ndpr_deletion_request_id UUID;

-- RLS: service role only for admin access
ALTER TABLE public.ndpr_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_ndpr" ON public.ndpr_requests
  USING (auth.role() = 'service_role');

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_ndpr_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ndpr_updated_at
  BEFORE UPDATE ON public.ndpr_requests
  FOR EACH ROW EXECUTE FUNCTION update_ndpr_updated_at();
