-- Branch-aware storefront, part 4: merchant-defined delivery zones
-- (zip-code-keyed fee/minimum-order/ETA tables per branch). Sibling to the
-- existing flat-rate store_delivery_methods table (no zip/branch awareness)
-- and orthogonal to the Shipbubble live-courier integration. At checkout,
-- a zone match (branch_id + customer zip) is tried before falling back to
-- delivery_method_id / client-sent delivery_fee.

CREATE TABLE IF NOT EXISTS public.store_delivery_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES store_branches(id) ON DELETE CASCADE,
  zip_code VARCHAR(20) NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'NGN',
  min_order INTEGER NULL,
  estimated_minutes INTEGER NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT unique_branch_zone_zip UNIQUE (branch_id, zip_code)
);

CREATE INDEX IF NOT EXISTS idx_store_delivery_zones_branch_zip ON store_delivery_zones(branch_id, zip_code);
