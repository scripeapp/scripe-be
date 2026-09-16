-- Add extended metadata columns to products
ALTER TABLE products 
ADD COLUMN IF NOT EXISTS digital JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS physical JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS service JSONB DEFAULT '{}'::jsonb,
-- Ensure variant customization columns exist (idempotent)
ADD COLUMN IF NOT EXISTS variant_group_name VARCHAR(50) DEFAULT 'Options',
ADD COLUMN IF NOT EXISTS variant_ui_type VARCHAR(20) DEFAULT 'pills';

-- Ensure product_variants usage (idempotent)
ALTER TABLE product_variants
ADD COLUMN IF NOT EXISTS color_value VARCHAR(50);

-- Create store_reviews table
CREATE TABLE IF NOT EXISTS store_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  customer_name VARCHAR(100) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title VARCHAR(150),
  content TEXT,
  is_verified BOOLEAN DEFAULT false,
  is_visible BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for store_reviews
CREATE INDEX IF NOT EXISTS idx_store_reviews_store ON store_reviews(store_id);
CREATE INDEX IF NOT EXISTS idx_store_reviews_product ON store_reviews(product_id);
