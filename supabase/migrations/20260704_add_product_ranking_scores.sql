-- Add ranking score columns to products for smarter best-seller sorting.
-- trending_score: time-decayed order volume (refreshed nightly by scheduler)
-- revenue_score: revenue-weighted score over last 30 days (refreshed nightly)
-- Both default to 0 so existing rows are still sortable immediately.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS trending_score NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revenue_score  NUMERIC DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_products_trending_score ON products(trending_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_products_revenue_score  ON products(revenue_score  DESC NULLS LAST);
