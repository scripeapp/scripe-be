-- Paid Subscriptions for Hilaq Publications
-- Migration: 20260110_paid_publications.sql

-- =============================================================================
-- 1. Extend publications table with monetization settings
-- =============================================================================
ALTER TABLE publications 
ADD COLUMN IF NOT EXISTS monetization JSONB DEFAULT NULL;
-- Structure:
-- {
--   "enabled": boolean,
--   "monthly_price": number (in kobo),
--   "yearly_price": number (in kobo),
--   "currency": "NGN",
--   "fee_bearer": "subaccount" | "customer"
-- }

COMMENT ON COLUMN publications.monetization IS 'Monetization settings for paid subscriptions. Prices in kobo.';

-- =============================================================================
-- 2. Extend subscriptions table for paid subscriptions
-- =============================================================================
-- subscription_type column already exists from existing code (values: 'free', 'paid')

ALTER TABLE subscriptions 
ADD COLUMN IF NOT EXISTS plan VARCHAR(20),
ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active',
ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMP,
ADD COLUMN IF NOT EXISTS paystack_subscription_code VARCHAR(100),
ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;

-- Add constraints
ALTER TABLE subscriptions 
DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
ALTER TABLE subscriptions 
ADD CONSTRAINT subscriptions_plan_check 
CHECK (plan IS NULL OR plan IN ('monthly', 'yearly'));

ALTER TABLE subscriptions 
DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE subscriptions 
ADD CONSTRAINT subscriptions_status_check 
CHECK (status IN ('active', 'cancelled', 'expired'));

COMMENT ON COLUMN subscriptions.plan IS 'Subscription billing plan: monthly or yearly. NULL for free subscriptions.';
COMMENT ON COLUMN subscriptions.status IS 'Subscription status: active, cancelled (access until period end), expired.';
COMMENT ON COLUMN subscriptions.current_period_end IS 'When the current billing period ends. NULL for free subscriptions.';
COMMENT ON COLUMN subscriptions.paystack_subscription_code IS 'Paystack subscription code for recurring billing.';
COMMENT ON COLUMN subscriptions.cancelled_at IS 'Timestamp when cancellation was requested.';

-- =============================================================================
-- 3. Extend posts table with visibility
-- =============================================================================
ALTER TABLE posts 
ADD COLUMN IF NOT EXISTS visibility VARCHAR(30) DEFAULT 'public';

ALTER TABLE posts 
DROP CONSTRAINT IF EXISTS posts_visibility_check;
ALTER TABLE posts 
ADD CONSTRAINT posts_visibility_check 
CHECK (visibility IN ('public', 'free_subscribers', 'paid_subscribers'));

COMMENT ON COLUMN posts.visibility IS 'Post visibility: public (everyone), free_subscribers (any subscriber), paid_subscribers (paid only).';

-- =============================================================================
-- 4. Create subscription_payments table
-- =============================================================================
CREATE TABLE IF NOT EXISTS subscription_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  currency VARCHAR(3) DEFAULT 'NGN',
  paystack_reference VARCHAR(100) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP,
  CONSTRAINT subscription_payments_status_check CHECK (status IN ('pending', 'success', 'failed'))
);

COMMENT ON TABLE subscription_payments IS 'Payment records for publication subscriptions.';
COMMENT ON COLUMN subscription_payments.amount IS 'Payment amount in kobo/cents.';

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_subscription_payments_subscription_id 
  ON subscription_payments(subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_reference 
  ON subscription_payments(paystack_reference);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_status 
  ON subscription_payments(status);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_created_at 
  ON subscription_payments(created_at);

-- =============================================================================
-- 5. Indexes for subscriptions table
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_publication 
  ON subscriptions(user_id, publication_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status 
  ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_current_period_end 
  ON subscriptions(current_period_end) WHERE status = 'cancelled';
CREATE INDEX IF NOT EXISTS idx_subscriptions_paystack_code 
  ON subscriptions(paystack_subscription_code) WHERE paystack_subscription_code IS NOT NULL;

-- =============================================================================
-- 6. RLS Policies
-- =============================================================================
ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;

-- Subscription payments visible to subscription owner
DROP POLICY IF EXISTS "Users can view their subscription payments" ON subscription_payments;
CREATE POLICY "Users can view their subscription payments" ON subscription_payments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM subscriptions s 
      WHERE s.id = subscription_payments.subscription_id 
      AND s.user_id = auth.uid()
    )
  );

-- Publication owners can view payments for their publications
DROP POLICY IF EXISTS "Publication owners can view subscription payments" ON subscription_payments;
CREATE POLICY "Publication owners can view subscription payments" ON subscription_payments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM subscriptions s
      JOIN publications p ON s.publication_id = p.id
      WHERE s.id = subscription_payments.subscription_id 
      AND is_business_member(p.business_id)
    )
  );

-- Service role can manage payments (for webhook processing)
DROP POLICY IF EXISTS "Service can manage subscription payments" ON subscription_payments;
CREATE POLICY "Service can manage subscription payments" ON subscription_payments
  FOR ALL USING (auth.role() = 'service_role');

-- =============================================================================
-- 7. Update subscriptions RLS for user access
-- =============================================================================
-- Allow users to view their own subscriptions
DROP POLICY IF EXISTS "Users can view their own subscriptions" ON subscriptions;
CREATE POLICY "Users can view their own subscriptions" ON subscriptions
  FOR SELECT USING (user_id = auth.uid());

-- Allow users to insert their own subscriptions
DROP POLICY IF EXISTS "Users can create subscriptions" ON subscriptions;
CREATE POLICY "Users can create subscriptions" ON subscriptions
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- Allow users to update their own subscriptions (for cancellation)
DROP POLICY IF EXISTS "Users can update their subscriptions" ON subscriptions;
CREATE POLICY "Users can update their subscriptions" ON subscriptions
  FOR UPDATE USING (user_id = auth.uid());

-- Service role can manage all subscriptions
DROP POLICY IF EXISTS "Service can manage subscriptions" ON subscriptions;
CREATE POLICY "Service can manage subscriptions" ON subscriptions
  FOR ALL USING (auth.role() = 'service_role');
