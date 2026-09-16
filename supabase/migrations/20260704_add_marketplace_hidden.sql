-- ADM-001: Per-item marketplace suppression flag
-- Admins can hide specific products, events, or circles from marketplace
-- without unpublishing them from the merchant's store/page.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS marketplace_hidden BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS marketplace_hidden BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE circles
  ADD COLUMN IF NOT EXISTS marketplace_hidden BOOLEAN NOT NULL DEFAULT false;

-- Partial indexes: only hidden rows need indexing (rare case, keeps marketplace queries fast)
CREATE INDEX IF NOT EXISTS idx_products_marketplace_hidden
  ON products (marketplace_hidden) WHERE marketplace_hidden = true;

CREATE INDEX IF NOT EXISTS idx_events_marketplace_hidden
  ON events (marketplace_hidden) WHERE marketplace_hidden = true;

CREATE INDEX IF NOT EXISTS idx_circles_marketplace_hidden
  ON circles (marketplace_hidden) WHERE marketplace_hidden = true;

COMMENT ON COLUMN products.marketplace_hidden IS 'When true, admin has suppressed this product from marketplace. Merchant store page still shows it.';
COMMENT ON COLUMN events.marketplace_hidden IS 'When true, admin has suppressed this event from marketplace.';
COMMENT ON COLUMN circles.marketplace_hidden IS 'When true, admin has suppressed this circle from marketplace.';
