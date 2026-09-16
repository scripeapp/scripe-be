-- Branch-aware storefront, part 1: per-branch product price + availability
-- overrides. Replaces the previously-decorative products.available_branch_ids
-- (never read/filtered by any query) with a proper override table that can
-- express both "unavailable at branch X" and "different price at branch X"
-- in one place. No row for a (product, branch) pair = available everywhere,
-- base price.

CREATE TABLE IF NOT EXISTS public.product_branch_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES store_branches(id) ON DELETE CASCADE,
  is_available BOOLEAN NOT NULL DEFAULT true,
  price INTEGER NULL,
  currency_prices JSONB NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT unique_product_branch_override UNIQUE (product_id, branch_id)
);

CREATE INDEX IF NOT EXISTS idx_product_branch_overrides_product ON product_branch_overrides(product_id);
CREATE INDEX IF NOT EXISTS idx_product_branch_overrides_branch ON product_branch_overrides(branch_id);
