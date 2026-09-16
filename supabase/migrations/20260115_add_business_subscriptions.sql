-- ============================================================================
-- Business Subscription System - Database Schema
-- ============================================================================
-- Adds subscription-related columns to businesses table and creates
-- plan_limits reference table for tier management.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Add subscription columns to businesses table
-- ============================================================================

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS subscription_plan TEXT DEFAULT 'starter',
  ADD COLUMN IF NOT EXISTS subscription_status TEXT,
  ADD COLUMN IF NOT EXISTS subscription_reference TEXT,
  ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_meta JSONB DEFAULT '{}';

-- Add constraints (with error handling for idempotency)
DO $$
BEGIN
  ALTER TABLE businesses
    ADD CONSTRAINT businesses_subscription_plan_check
    CHECK (subscription_plan IN ('starter', 'plus', 'pro'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE businesses
    ADD CONSTRAINT businesses_subscription_status_check
    CHECK (subscription_status IN ('active', 'trialing', 'cancelled', 'expired', 'past_due') OR subscription_status IS NULL);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Comments
COMMENT ON COLUMN businesses.subscription_plan IS 'Current plan: starter, plus, or pro';
COMMENT ON COLUMN businesses.subscription_status IS 'Status: active, trialing, cancelled, expired, past_due';
COMMENT ON COLUMN businesses.subscription_reference IS 'Paystack subscription code';
COMMENT ON COLUMN businesses.subscription_started_at IS 'When the subscription started';
COMMENT ON COLUMN businesses.subscription_updated_at IS 'Last update timestamp';
COMMENT ON COLUMN businesses.subscription_expires_at IS 'When current period ends (for cancellation handling)';
COMMENT ON COLUMN businesses.subscription_meta IS 'Additional metadata (provider, plan_code, etc.)';

-- ============================================================================
-- 2. Create plan_limits reference table
-- ============================================================================

CREATE TABLE IF NOT EXISTS plan_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan TEXT UNIQUE NOT NULL,
  limits JSONB NOT NULL,
  features JSONB NOT NULL,
  price_monthly INTEGER, -- In kobo (NGN cents)
  price_yearly INTEGER,
  paystack_plan_code TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS (read-only for everyone)
ALTER TABLE plan_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY plan_limits_select_policy ON plan_limits
  FOR SELECT USING (true);

-- ============================================================================
-- 3. Seed plan data
-- ============================================================================

INSERT INTO plan_limits (plan, limits, features, price_monthly, paystack_plan_code) VALUES
('starter', '{
  "publications": 1,
  "sessions": 3,
  "products": 10,
  "website_pages": 1,
  "crm_contacts": 100,
  "team_members": 1,
  "segments": 0,
  "campaigns_per_month": 0
}'::jsonb, '{
  "events": true,
  "store": true,
  "digital_downloads": true,
  "courses": false,
  "memberships": false,
  "services_bookings": true,
  "advanced_page_builder": false,
  "custom_domain": false,
  "custom_roles": false,
  "email_support": false,
  "priority_support": false,
  "advanced_analytics": false,
  "ai_assistant": false
}'::jsonb, 0, NULL),

('plus', '{
  "publications": 2,
  "sessions": 10,
  "products": 20,
  "website_pages": 3,
  "crm_contacts": 1000,
  "team_members": 3,
  "segments": 3,
  "campaigns_per_month": 5
}'::jsonb, '{
  "events": true,
  "store": true,
  "digital_downloads": true,
  "courses": false,
  "memberships": false,
  "services_bookings": true,
  "advanced_page_builder": true,
  "custom_domain": false,
  "custom_roles": false,
  "email_support": true,
  "priority_support": false,
  "advanced_analytics": false,
  "ai_assistant": true
}'::jsonb, 400000, 'hilaq-plus'), -- ₦4,000 = 400,000 kobo

('pro', '{
  "publications": 3,
  "sessions": "unlimited",
  "products": "unlimited",
  "website_pages": "unlimited",
  "crm_contacts": 10000,
  "team_members": 7,
  "segments": "unlimited",
  "campaigns_per_month": "unlimited"
}'::jsonb, '{
  "events": true,
  "store": true,
  "digital_downloads": true,
  "courses": true,
  "memberships": true,
  "services_bookings": true,
  "advanced_page_builder": true,
  "custom_domain": true,
  "custom_roles": true,
  "email_support": true,
  "priority_support": true,
  "advanced_analytics": true,
  "ai_assistant": true
}'::jsonb, 750000, 'hilaq-pro') -- ₦7,500 = 750,000 kobo

ON CONFLICT (plan) DO UPDATE SET
  limits = EXCLUDED.limits,
  features = EXCLUDED.features,
  price_monthly = EXCLUDED.price_monthly,
  paystack_plan_code = EXCLUDED.paystack_plan_code,
  updated_at = NOW();

-- ============================================================================
-- 4. Migrate existing user subscriptions to businesses
-- ============================================================================

-- Copy subscription data from owner's user record to their businesses
-- Note: users table only has subscription_plan, subscription_status, 
-- subscription_reference, subscription_updated_at columns
UPDATE businesses b
SET
  subscription_plan = COALESCE(
    CASE 
      WHEN LOWER(u.subscription_plan) LIKE '%pro%' THEN 'pro'
      WHEN LOWER(u.subscription_plan) LIKE '%plus%' OR LOWER(u.subscription_plan) LIKE '%premium%' THEN 'plus'
      ELSE 'starter'
    END,
    'starter'
  ),
  subscription_status = u.subscription_status,
  subscription_reference = u.subscription_reference,
  subscription_updated_at = u.subscription_updated_at
FROM users u
WHERE b.owner_user_id = u.id
  AND u.subscription_plan IS NOT NULL
  AND b.subscription_status IS NULL; -- Only update if not already set

COMMIT;
