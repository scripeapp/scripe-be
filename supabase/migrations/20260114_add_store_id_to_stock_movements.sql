-- Add store_id to stock_movements table
ALTER TABLE stock_movements
ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id) ON DELETE CASCADE;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_stock_movements_store ON stock_movements(store_id);

-- Backfill store_id from products table for existing records
UPDATE stock_movements sm
SET store_id = p.store_id
FROM products p
WHERE sm.product_id = p.id
AND sm.store_id IS NULL;

-- Make store_id required after backfill
-- ALTER TABLE stock_movements ALTER COLUMN store_id SET NOT NULL;
