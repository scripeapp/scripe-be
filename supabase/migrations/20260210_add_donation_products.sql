-- Allow donation products and store donation metadata

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_type_check;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS donation JSONB DEFAULT NULL;

ALTER TABLE products
  ADD CONSTRAINT products_type_check
  CHECK (type IN ('digital', 'physical', 'service', 'course', 'ebook', 'membership', 'bundle', 'donation'));

COMMENT ON COLUMN products.donation IS 'Donation metadata: suggested_amount (NGN), allow_custom_amount';
