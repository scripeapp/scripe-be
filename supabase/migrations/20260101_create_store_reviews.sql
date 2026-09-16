-- Create store_reviews table
CREATE TABLE IF NOT EXISTS public.store_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_id UUID REFERENCES store_orders(id) ON DELETE SET NULL,
  customer_email VARCHAR(255) NOT NULL,
  customer_name VARCHAR(255) NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title VARCHAR(255),
  content TEXT,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  is_verified BOOLEAN DEFAULT false,
  is_visible BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_reviews_store ON store_reviews(store_id, is_visible, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON store_reviews(product_id, is_visible);
CREATE INDEX IF NOT EXISTS idx_reviews_order ON store_reviews(order_id);

-- Prevent duplicate reviews: one review per order per product
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_order_product_review 
ON store_reviews(order_id, product_id) WHERE order_id IS NOT NULL AND product_id IS NOT NULL;

-- Prevent duplicate general reviews per order (when no product specified)
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_order_review 
ON store_reviews(order_id) WHERE order_id IS NOT NULL AND product_id IS NULL;
