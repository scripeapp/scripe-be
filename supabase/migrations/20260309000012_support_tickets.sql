-- ============================================================
-- PHASE 4: Support / Helpdesk Tickets
-- ============================================================

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject          TEXT NOT NULL,
  description      TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'other'
                   CHECK (category IN ('billing', 'technical', 'feature_request', 'account', 'other')),
  priority         TEXT NOT NULL DEFAULT 'medium'
                   CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  status           TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'in_progress', 'waiting_on_user', 'resolved', 'closed')),
  business_id      UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  submitter_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  submitter_email  TEXT,
  assigned_to      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON public.support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON public.support_tickets(priority);
CREATE INDEX IF NOT EXISTS idx_tickets_business ON public.support_tickets(business_id);
CREATE INDEX IF NOT EXISTS idx_tickets_created ON public.support_tickets(created_at DESC);

-- Ticket replies
CREATE TABLE IF NOT EXISTS public.support_ticket_replies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       UUID REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  author_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  author_email    TEXT,
  is_internal     BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_replies_ticket ON public.support_ticket_replies(ticket_id);

-- RLS
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_tickets" ON public.support_tickets
  USING (auth.role() = 'service_role');

ALTER TABLE public.support_ticket_replies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_replies" ON public.support_ticket_replies
  USING (auth.role() = 'service_role');

-- Updated_at
CREATE OR REPLACE FUNCTION update_tickets_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tickets_updated_at
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION update_tickets_updated_at();
