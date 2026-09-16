-- Create product_versions table
CREATE TABLE IF NOT EXISTS product_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  version_name VARCHAR(50) NOT NULL,
  release_notes TEXT, -- Rich text JSON (Draft.js format)
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Only one active version per product
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_versions_active 
  ON product_versions(product_id) 
  WHERE is_active = true;

-- Index for efficient querying
CREATE INDEX IF NOT EXISTS idx_product_versions_product ON product_versions(product_id);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS product_versions_set_updated_at ON product_versions;
CREATE TRIGGER product_versions_set_updated_at
BEFORE UPDATE ON product_versions
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
