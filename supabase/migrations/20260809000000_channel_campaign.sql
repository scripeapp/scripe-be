-- Hilaq SMS and WhatsApp campaign channels.
-- This migration intentionally rebuilds only the channel-campaign objects.

DROP FUNCTION IF EXISTS public.reserve_channel_message_credits(UUID, UUID, INTEGER, INTEGER, INTEGER, TEXT, UUID, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.refund_channel_message_credits(UUID, UUID, UUID, INTEGER, TEXT);
DROP FUNCTION IF EXISTS public.credit_campaign_account(UUID, INTEGER, TEXT, UUID, JSONB);
DROP FUNCTION IF EXISTS public.debit_campaign_credits(UUID, INTEGER, UUID, JSONB);

DROP TABLE IF EXISTS public.channel_message_delivery CASCADE;
DROP TABLE IF EXISTS public.channel_message CASCADE;
DROP TABLE IF EXISTS public.channel_template CASCADE;
DROP TABLE IF EXISTS public.channel_automation_step CASCADE;
DROP TABLE IF EXISTS public.channel_automation CASCADE;
DROP TABLE IF EXISTS public.campaign_credit_transactions CASCADE;
DROP TABLE IF EXISTS public.campaign_credit_accounts CASCADE;

ALTER TABLE public.contacts
  DROP COLUMN IF EXISTS whatsapp_opted_in,
  DROP COLUMN IF EXISTS sms_opted_out;

ALTER TABLE public.contacts
  ADD COLUMN whatsapp_opted_in BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN sms_opted_out BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE public.channel_template (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
  name VARCHAR(255) NOT NULL,
  category TEXT NOT NULL DEFAULT 'marketing'
    CHECK (category IN ('marketing', 'utility', 'authentication', 'internal')),
  header_type TEXT NOT NULL DEFAULT 'none'
    CHECK (header_type IN ('none', 'text', 'image', 'document')),
  header_content TEXT,
  body TEXT NOT NULL,
  footer TEXT,
  buttons JSONB NOT NULL DEFAULT '[]'::jsonb,
  wa_template_id VARCHAR(255),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'internal')),
  rejection_reason TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.channel_message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
  name VARCHAR(255) NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'preparing', 'scheduled', 'queued', 'processing', 'sent', 'partial', 'failed')),
  segment_id UUID REFERENCES public.segments(id) ON DELETE SET NULL,
  template_id UUID REFERENCES public.channel_template(id) ON DELETE SET NULL,
  body_override TEXT,
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  recipient_count INTEGER,
  suppressed_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  read_count INTEGER NOT NULL DEFAULT 0,
  replied_count INTEGER NOT NULL DEFAULT 0,
  clicked_count INTEGER NOT NULL DEFAULT 0,
  optout_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  credits_reserved INTEGER NOT NULL DEFAULT 0 CHECK (credits_reserved >= 0),
  credits_refunded INTEGER NOT NULL DEFAULT 0 CHECK (credits_refunded >= 0),
  message_parts INTEGER NOT NULL DEFAULT 1 CHECK (message_parts > 0),
  provider TEXT,
  queue_message_id TEXT,
  send_attempt_id UUID,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.channel_message_delivery (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES public.channel_message(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  body TEXT NOT NULL,
  credit_cost INTEGER NOT NULL CHECK (credit_cost > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'accepted', 'delivered', 'failed')),
  provider_message_id TEXT,
  provider_status TEXT,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  accepted_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, phone)
);

CREATE TABLE public.campaign_credit_accounts (
  business_id UUID PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.campaign_credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('topup', 'debit', 'adjustment', 'refund')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  paystack_reference TEXT,
  campaign_id UUID REFERENCES public.campaigns(id) ON DELETE SET NULL,
  channel_message_id UUID REFERENCES public.channel_message(id) ON DELETE SET NULL,
  channel_attempt_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_channel_message_business_channel ON public.channel_message(business_id, channel);
CREATE INDEX idx_channel_message_status ON public.channel_message(status);
CREATE INDEX idx_channel_template_business_channel ON public.channel_template(business_id, channel);
CREATE INDEX idx_channel_template_status ON public.channel_template(status);
CREATE INDEX idx_channel_delivery_message_status ON public.channel_message_delivery(message_id, status, id);
CREATE UNIQUE INDEX idx_channel_delivery_provider_message
  ON public.channel_message_delivery(provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX idx_campaign_credit_topup_reference
  ON public.campaign_credit_transactions(paystack_reference)
  WHERE type = 'topup' AND paystack_reference IS NOT NULL;
CREATE INDEX idx_campaign_credit_business_created
  ON public.campaign_credit_transactions(business_id, created_at DESC);
CREATE UNIQUE INDEX idx_campaign_credit_channel_debit
  ON public.campaign_credit_transactions(channel_message_id, channel_attempt_id)
  WHERE type = 'debit' AND channel_message_id IS NOT NULL AND channel_attempt_id IS NOT NULL;
CREATE UNIQUE INDEX idx_campaign_credit_channel_refund
  ON public.campaign_credit_transactions(channel_message_id, channel_attempt_id)
  WHERE type = 'refund' AND channel_message_id IS NOT NULL AND channel_attempt_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.set_channel_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_channel_template_updated BEFORE UPDATE ON public.channel_template
  FOR EACH ROW EXECUTE FUNCTION public.set_channel_updated_at();
CREATE TRIGGER trg_channel_message_updated BEFORE UPDATE ON public.channel_message
  FOR EACH ROW EXECUTE FUNCTION public.set_channel_updated_at();

ALTER TABLE public.channel_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_message_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_credit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_credit_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY channel_template_member_access ON public.channel_template FOR ALL
  USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = channel_template.business_id AND b.owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.business_id = channel_template.business_id AND m.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = channel_template.business_id AND b.owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.business_id = channel_template.business_id AND m.user_id = auth.uid()));

CREATE POLICY channel_message_member_access ON public.channel_message FOR ALL
  USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = channel_message.business_id AND b.owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.business_id = channel_message.business_id AND m.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = channel_message.business_id AND b.owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.business_id = channel_message.business_id AND m.user_id = auth.uid()));

CREATE POLICY channel_delivery_member_access ON public.channel_message_delivery FOR ALL
  USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = channel_message_delivery.business_id AND b.owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.business_id = channel_message_delivery.business_id AND m.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = channel_message_delivery.business_id AND b.owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.business_id = channel_message_delivery.business_id AND m.user_id = auth.uid()));

CREATE POLICY campaign_credit_account_member_read ON public.campaign_credit_accounts FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = campaign_credit_accounts.business_id AND b.owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.business_id = campaign_credit_accounts.business_id AND m.user_id = auth.uid()));

CREATE POLICY campaign_credit_transaction_member_read ON public.campaign_credit_transactions FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = campaign_credit_transactions.business_id AND b.owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.business_id = campaign_credit_transactions.business_id AND m.user_id = auth.uid()));

CREATE OR REPLACE FUNCTION public.credit_campaign_account(
  p_business_id UUID, p_amount INTEGER, p_paystack_reference TEXT,
  p_created_by UUID DEFAULT NULL, p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS TABLE(balance INTEGER, already_processed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing public.campaign_credit_transactions%ROWTYPE; v_balance INTEGER;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Campaign credit top-ups require the service role'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Credit amount must be greater than zero'; END IF;
  SELECT * INTO v_existing FROM public.campaign_credit_transactions
    WHERE type = 'topup' AND paystack_reference = p_paystack_reference LIMIT 1;
  IF FOUND THEN RETURN QUERY SELECT v_existing.balance_after, TRUE; RETURN; END IF;
  INSERT INTO public.campaign_credit_accounts (business_id, balance)
    VALUES (p_business_id, p_amount)
    ON CONFLICT (business_id) DO UPDATE SET balance = campaign_credit_accounts.balance + EXCLUDED.balance, updated_at = NOW()
    RETURNING campaign_credit_accounts.balance INTO v_balance;
  INSERT INTO public.campaign_credit_transactions (business_id, type, amount, balance_after, paystack_reference, metadata, created_by)
    VALUES (p_business_id, 'topup', p_amount, v_balance, p_paystack_reference, COALESCE(p_metadata, '{}'::jsonb), p_created_by);
  RETURN QUERY SELECT v_balance, FALSE;
END; $$;

CREATE OR REPLACE FUNCTION public.debit_campaign_credits(
  p_business_id UUID, p_amount INTEGER, p_campaign_id UUID DEFAULT NULL, p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS TABLE(balance INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_balance INTEGER;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = p_business_id AND b.owner_user_id = auth.uid())
    AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.business_id = p_business_id AND m.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized for this business';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Debit amount must be greater than zero'; END IF;
  INSERT INTO public.campaign_credit_accounts (business_id) VALUES (p_business_id) ON CONFLICT DO NOTHING;
  UPDATE public.campaign_credit_accounts SET balance = balance - p_amount, updated_at = NOW()
    WHERE business_id = p_business_id AND balance >= p_amount RETURNING balance INTO v_balance;
  IF v_balance IS NULL THEN RAISE EXCEPTION 'INSUFFICIENT_CAMPAIGN_CREDITS'; END IF;
  INSERT INTO public.campaign_credit_transactions (business_id, type, amount, balance_after, campaign_id, metadata)
    VALUES (p_business_id, 'debit', p_amount, v_balance, p_campaign_id, COALESCE(p_metadata, '{}'::jsonb));
  RETURN QUERY SELECT v_balance;
END; $$;

CREATE OR REPLACE FUNCTION public.reserve_channel_message_credits(
  p_business_id UUID, p_message_id UUID, p_amount INTEGER, p_recipient_count INTEGER,
  p_message_parts INTEGER, p_provider TEXT, p_attempt_id UUID, p_scheduled_at TIMESTAMPTZ DEFAULT NULL
) RETURNS TABLE(balance INTEGER, already_reserved BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_balance INTEGER; v_existing public.campaign_credit_transactions%ROWTYPE; v_status TEXT;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = p_business_id AND b.owner_user_id = auth.uid())
    AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.business_id = p_business_id AND m.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized for this business';
  END IF;
  IF p_amount <= 0 OR p_recipient_count <= 0 OR p_message_parts <= 0 OR p_attempt_id IS NULL THEN RAISE EXCEPTION 'Invalid channel campaign reservation'; END IF;
  SELECT status INTO v_status FROM public.channel_message WHERE id = p_message_id AND business_id = p_business_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'Channel message not found'; END IF;
  SELECT * INTO v_existing FROM public.campaign_credit_transactions WHERE channel_message_id = p_message_id AND channel_attempt_id = p_attempt_id AND type = 'debit' LIMIT 1;
  IF FOUND THEN RETURN QUERY SELECT v_existing.balance_after, TRUE; RETURN; END IF;
  IF v_status <> 'preparing' THEN RAISE EXCEPTION 'Channel message is not ready for reservation'; END IF;
  INSERT INTO public.campaign_credit_accounts (business_id) VALUES (p_business_id) ON CONFLICT DO NOTHING;
  UPDATE public.campaign_credit_accounts SET balance = balance - p_amount, updated_at = NOW()
    WHERE business_id = p_business_id AND balance >= p_amount RETURNING balance INTO v_balance;
  IF v_balance IS NULL THEN RAISE EXCEPTION 'INSUFFICIENT_CAMPAIGN_CREDITS'; END IF;
  INSERT INTO public.campaign_credit_transactions (business_id, type, amount, balance_after, channel_message_id, channel_attempt_id, metadata)
    VALUES (p_business_id, 'debit', p_amount, v_balance, p_message_id, p_attempt_id,
      jsonb_build_object('channel', (SELECT channel FROM public.channel_message WHERE id = p_message_id)));
  UPDATE public.channel_message SET status = CASE WHEN p_scheduled_at IS NULL THEN 'queued' ELSE 'scheduled' END,
    scheduled_at = p_scheduled_at, recipient_count = p_recipient_count, credits_reserved = p_amount,
    credits_refunded = 0, message_parts = p_message_parts, provider = p_provider, send_attempt_id = p_attempt_id
    WHERE id = p_message_id;
  RETURN QUERY SELECT v_balance, FALSE;
END; $$;

CREATE OR REPLACE FUNCTION public.refund_channel_message_credits(
  p_business_id UUID, p_message_id UUID, p_attempt_id UUID, p_amount INTEGER, p_reason TEXT
) RETURNS TABLE(balance INTEGER, already_refunded BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_balance INTEGER; v_existing public.campaign_credit_transactions%ROWTYPE; v_reserved INTEGER;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
    AND NOT EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = p_business_id AND b.owner_user_id = auth.uid())
    AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.business_id = p_business_id AND m.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized for this business';
  END IF;
  IF p_amount <= 0 OR p_attempt_id IS NULL THEN RAISE EXCEPTION 'Refund amount must be greater than zero'; END IF;
  SELECT credits_reserved INTO v_reserved FROM public.channel_message WHERE id = p_message_id AND business_id = p_business_id FOR UPDATE;
  IF v_reserved IS NULL OR p_amount > v_reserved THEN RAISE EXCEPTION 'Invalid channel campaign refund'; END IF;
  SELECT * INTO v_existing FROM public.campaign_credit_transactions WHERE channel_message_id = p_message_id AND channel_attempt_id = p_attempt_id AND type = 'refund' LIMIT 1;
  IF FOUND THEN RETURN QUERY SELECT v_existing.balance_after, TRUE; RETURN; END IF;
  UPDATE public.campaign_credit_accounts SET balance = balance + p_amount, updated_at = NOW()
    WHERE business_id = p_business_id RETURNING balance INTO v_balance;
  INSERT INTO public.campaign_credit_transactions (business_id, type, amount, balance_after, channel_message_id, channel_attempt_id, metadata)
    VALUES (p_business_id, 'refund', p_amount, v_balance, p_message_id, p_attempt_id, jsonb_build_object('reason', p_reason));
  UPDATE public.channel_message SET credits_refunded = p_amount, status = CASE WHEN p_reason = 'queue_unavailable' THEN 'draft' ELSE status END WHERE id = p_message_id;
  RETURN QUERY SELECT v_balance, FALSE;
END; $$;

REVOKE ALL ON FUNCTION public.credit_campaign_account(UUID, INTEGER, TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.credit_campaign_account(UUID, INTEGER, TEXT, UUID, JSONB) TO service_role;
REVOKE ALL ON FUNCTION public.debit_campaign_credits(UUID, INTEGER, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.debit_campaign_credits(UUID, INTEGER, UUID, JSONB) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.reserve_channel_message_credits(UUID, UUID, INTEGER, INTEGER, INTEGER, TEXT, UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_channel_message_credits(UUID, UUID, INTEGER, INTEGER, INTEGER, TEXT, UUID, TIMESTAMPTZ) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.refund_channel_message_credits(UUID, UUID, UUID, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refund_channel_message_credits(UUID, UUID, UUID, INTEGER, TEXT) TO authenticated, service_role;
