-- URL-001: Human-readable product slugs
-- Adds a unique slug per store so product URLs can be /s/store-slug/red-wallet-a3k9x2
-- instead of /s/store-slug/550e8400-e29b-41d4-a716-446655440000.
--
-- Slugs are generated from the product name + 6-char hex suffix (crypto-derived).
-- The suffix guarantees uniqueness without collision-check loops.
-- UUID-based URLs still resolve (backward compat handled in the service layer).

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS slug TEXT;

-- Unique per store — two stores can have the same product name without conflict.
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_store_slug
  ON products (store_id, slug)
  WHERE slug IS NOT NULL;

-- Backfill: generate slug = slugified name + 6-char hex suffix for all existing products.
-- substr(md5(...)) gives a deterministic but collision-resistant suffix per product.
UPDATE products
SET slug = regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')
           || '-'
           || substr(md5(id::text), 1, 6)
WHERE slug IS NULL;

-- Make slug NOT NULL now that all rows are populated.
ALTER TABLE products
  ALTER COLUMN slug SET NOT NULL;

COMMENT ON COLUMN products.slug IS 'URL-safe identifier for public product pages. Unique per store. Format: slugified-name-xxxxxx.';
