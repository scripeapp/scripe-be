-- Digital Product Storage Tables
-- order_downloads: Tracks download history for digital products

CREATE TABLE order_downloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES store_orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id UUID,
  downloaded_at TIMESTAMPTZ DEFAULT NOW(),
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_order_downloads_order ON order_downloads(order_id);
CREATE INDEX idx_order_downloads_product ON order_downloads(product_id);
CREATE INDEX idx_order_downloads_user ON order_downloads(user_id);

-- RLS Policies
ALTER TABLE order_downloads ENABLE ROW LEVEL SECURITY;

-- Users can view their own download history
CREATE POLICY "Users can view own downloads"
  ON order_downloads
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Store owners can view all downloads for their products
CREATE POLICY "Store owners can view product downloads"
  ON order_downloads
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM products p
      JOIN stores s ON s.id = p.store_id
      JOIN memberships m ON m.business_id = s.business_id
      WHERE p.id = order_downloads.product_id
        AND m.user_id = auth.uid()
    )
  );

-- Insert policy for download tracking
CREATE POLICY "Anyone can insert download record"
  ON order_downloads
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Add file_size column to products if not exists
-- (file_size stored in digital JSONB, but we add explicit column for queries)
ALTER TABLE products ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT;

COMMENT ON TABLE order_downloads IS 'Tracks download history for digital products';
COMMENT ON COLUMN products.file_size_bytes IS 'File size in bytes for digital products';
