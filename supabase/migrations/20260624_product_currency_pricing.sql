-- Per-currency product pricing
--
-- Lets a store sell in a chosen subset of currencies and set an explicit price
-- per currency for individual products. Any currency a product does not price
-- explicitly still falls back to live FX conversion of the NGN base price, so
-- existing products keep their current behaviour.

-- The currencies a store is willing to sell in. NGN is the implicit base and is
-- always allowed regardless of this list.
ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS supported_currencies TEXT[] NOT NULL DEFAULT ARRAY['NGN'];

-- Explicit per-currency prices for a product, keyed by ISO currency code.
-- Shape: { "USD": { "price": 19.99, "compare_at_price": 24.99 }, ... }
-- Only non-NGN overrides are stored here; the NGN base lives in products.price.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS currency_prices JSONB NOT NULL DEFAULT '{}'::jsonb;
