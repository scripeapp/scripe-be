-- Create analytics_events table
CREATE TABLE IF NOT EXISTS analytics_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_type VARCHAR(50) NOT NULL, -- 'page_view', 'product_view', 'add_to_cart', 'purchase', etc.
  resource_id UUID, -- ID of the product, store, or event
  resource_type VARCHAR(50), -- 'product', 'store', 'event'
  store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  session_id VARCHAR(100), -- For anonymous users
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_analytics_store_date ON analytics_events (store_id, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_resource ON analytics_events (resource_id, resource_type);
CREATE INDEX IF NOT EXISTS idx_analytics_session ON analytics_events (session_id);
CREATE INDEX IF NOT EXISTS idx_analytics_event_type ON analytics_events (event_type);

-- Enable RLS (though mostly accessed via service role for writing)
ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;

-- Policy: Stores can view their own analytics
CREATE POLICY "Stores can view their own analytics" ON analytics_events
  FOR SELECT
  USING (
    store_id IN (
      SELECT id FROM stores WHERE user_id = auth.uid()
    )
    OR
    business_id IN (
      SELECT id FROM businesses WHERE owner_id = auth.uid()
    )
  );

-- Policy: Admin/System can insert (public tracking endpoint will use service role or signed request)
-- For now, allow public insert for tracking (we will validate in controller)
-- Actually, better to insert via service role in backend to prevent spam. 
-- So no public INSERT policy for now.
