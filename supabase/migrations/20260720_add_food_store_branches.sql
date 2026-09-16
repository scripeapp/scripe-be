-- Food Store PRD Phase 1: store_type + store_branches
-- See docs/food-store-onboarding-prd.md

-- Store type: general (unchanged default flow) vs food (branches/menus/modifiers)
ALTER TABLE stores
ADD COLUMN IF NOT EXISTS store_type VARCHAR(20) NOT NULL DEFAULT 'general'
  CHECK (store_type IN ('general', 'food'));

CREATE INDEX IF NOT EXISTS idx_stores_store_type ON stores(store_type);

-- Branches: physical locations under a food store, each with its own
-- address, hours, and fulfilment types.
CREATE TABLE IF NOT EXISTS public.store_branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  -- { street, city, state, lat, lng }
  address JSONB NOT NULL DEFAULT '{}',
  phone VARCHAR(50),
  -- Same shape as stores.appearance.business_hours:
  -- { monday: { open, close } | null, ..., sunday: { open, close } | null }
  business_hours JSONB NOT NULL DEFAULT '{
    "monday": null, "tuesday": null, "wednesday": null, "thursday": null,
    "friday": null, "saturday": null, "sunday": null
  }',
  operation_types TEXT[] NOT NULL DEFAULT ARRAY['walk_in']::TEXT[]
    CHECK (
      cardinality(operation_types) > 0
      AND operation_types <@ ARRAY['walk_in', 'delivery']::TEXT[]
    ),
  prep_time_minutes INTEGER NOT NULL DEFAULT 20,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_store_branches_store ON store_branches(store_id, is_active);

-- At most one default branch per store
CREATE UNIQUE INDEX IF NOT EXISTS uniq_store_branches_default
  ON store_branches(store_id)
  WHERE is_default = true;
