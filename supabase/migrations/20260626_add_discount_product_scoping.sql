BEGIN;

ALTER TABLE discount_codes
  ADD COLUMN IF NOT EXISTS applies_to TEXT NOT NULL DEFAULT 'all'
    CHECK (applies_to IN ('all','specific')),
  ADD COLUMN IF NOT EXISTS product_ids UUID[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_discount_codes_product_ids
  ON discount_codes USING GIN (product_ids);

COMMIT;
