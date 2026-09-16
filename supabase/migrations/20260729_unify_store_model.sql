-- Product-level prep/menu capability flag (replaces store_type === 'food' gating)
ALTER TABLE products ADD COLUMN IF NOT EXISTS has_prep_time BOOLEAN NOT NULL DEFAULT false;

-- Backfill: existing food stores become real "sells in person" stores
UPDATE stores SET sells_in_person = true
  WHERE store_type = 'food' AND sells_in_person = false;

-- Backfill: existing food-store products keep their prep/allergen/modifier UI
UPDATE products SET has_prep_time = true
  WHERE store_id IN (SELECT id FROM stores WHERE store_type = 'food');
