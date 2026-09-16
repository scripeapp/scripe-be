-- Physical product wizard close-out: checkout collection settings + variant
-- commerce fields (cost / barcode / weight) introduced with the wizard rework.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS checkout JSONB;

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS cost DECIMAL(10, 2),
  ADD COLUMN IF NOT EXISTS barcode TEXT,
  ADD COLUMN IF NOT EXISTS weight DECIMAL(10, 3);