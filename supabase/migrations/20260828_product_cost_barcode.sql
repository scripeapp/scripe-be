ALTER TABLE products
  ADD COLUMN IF NOT EXISTS cost NUMERIC(12, 2) NULL,
  ADD COLUMN IF NOT EXISTS barcode TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_products_store_barcode
  ON products(store_id, barcode)
  WHERE barcode IS NOT NULL;

ALTER TABLE products
  ADD CONSTRAINT products_cost_nonnegative CHECK (cost IS NULL OR cost >= 0);
