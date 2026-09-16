-- Membership & Subscriptions Tables
-- Subscriptions for recurring membership products

-- Store Product Subscriptions (renamed to avoid conflict with publication subscriptions)
CREATE TABLE store_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  paystack_subscription_code TEXT,
  paystack_customer_code TEXT,
  paystack_email_token TEXT,
  status TEXT CHECK (status IN ('active', 'paused', 'cancelled', 'expired', 'pending')) DEFAULT 'pending',
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Membership Content (gated content for members)
CREATE TABLE membership_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  content JSONB DEFAULT '{}', -- { type: 'video'|'file'|'text', url, text_content }
  access_tier TEXT, -- matches membership.tier_name for tiered access
  position INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_store_subscriptions_user ON store_subscriptions(user_id);
CREATE INDEX idx_store_subscriptions_product ON store_subscriptions(product_id);
CREATE INDEX idx_store_subscriptions_store ON store_subscriptions(store_id);
CREATE INDEX idx_store_subscriptions_status ON store_subscriptions(status);
CREATE INDEX idx_store_subscriptions_paystack ON store_subscriptions(paystack_subscription_code);
CREATE INDEX idx_membership_content_product ON membership_content(product_id);
CREATE INDEX idx_membership_content_tier ON membership_content(access_tier);

-- RLS Policies
ALTER TABLE store_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_content ENABLE ROW LEVEL SECURITY;

-- Users can view their own subscriptions
CREATE POLICY "Users can view own store subscriptions"
  ON store_subscriptions FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Store owners can view subscriptions for their products
CREATE POLICY "Store owners can view product subscriptions"
  ON store_subscriptions FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM stores s
      JOIN memberships m ON m.business_id = s.business_id
      WHERE s.id = store_subscriptions.store_id AND m.user_id = auth.uid()
    )
  );

-- Insert/update by system (webhooks use service role)
CREATE POLICY "Authenticated can insert store subscriptions"
  ON store_subscriptions FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own store subscriptions"
  ON store_subscriptions FOR UPDATE TO authenticated
  USING (user_id = auth.uid());

-- Store owners can manage membership content
CREATE POLICY "Store owners can manage membership content"
  ON membership_content FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM products p
      JOIN stores s ON s.id = p.store_id
      JOIN memberships m ON m.business_id = s.business_id
      WHERE p.id = membership_content.product_id AND m.user_id = auth.uid()
    )
  );

-- Active subscribers can view content
CREATE POLICY "Subscribers can view membership content"
  ON membership_content FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM store_subscriptions sub
      WHERE sub.product_id = membership_content.product_id
        AND sub.user_id = auth.uid()
        AND sub.status = 'active'
    )
  );

COMMENT ON TABLE store_subscriptions IS 'User subscriptions for recurring membership store products';
COMMENT ON TABLE membership_content IS 'Gated content available to membership subscribers';
