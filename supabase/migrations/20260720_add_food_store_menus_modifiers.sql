-- Food Store PRD Phase 2: menus, modifier groups, unit-of-sale
-- See docs/food-store-onboarding-prd.md

-- Menus: a named grouping of categories (e.g. "Breakfast", "Catering"),
-- optionally schedule- and branch-scoped.
CREATE TABLE IF NOT EXISTS public.store_menus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  -- Same shape as store_branches.business_hours; null = always available
  availability JSONB,
  -- null/empty = available at all branches
  branch_ids UUID[],
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_store_menus_store ON store_menus(store_id, is_active, position);

-- Categories now belong to a menu (nullable for now — general stores and
-- pre-existing categories don't have one).
ALTER TABLE store_categories
ADD COLUMN IF NOT EXISTS menu_id UUID REFERENCES store_menus(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_store_categories_menu ON store_categories(menu_id);

-- Modifier groups: reusable, store-level option groups (e.g. "Proteins",
-- "Spice Level") attached to whichever products need them.
CREATE TABLE IF NOT EXISTS public.modifier_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  selection_type VARCHAR(20) NOT NULL DEFAULT 'single'
    CHECK (selection_type IN ('single', 'multiple')),
  min_selections INTEGER NOT NULL DEFAULT 0,
  max_selections INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_modifier_groups_store ON modifier_groups(store_id, position);

CREATE TABLE IF NOT EXISTS public.modifier_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  modifier_group_id UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  price_delta DECIMAL(10, 2) NOT NULL DEFAULT 0,
  is_available BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_modifier_options_group ON modifier_options(modifier_group_id, position);

-- Junction: which products a modifier group is attached to
CREATE TABLE IF NOT EXISTS public.product_modifier_groups (
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  modifier_group_id UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, modifier_group_id)
);

CREATE INDEX IF NOT EXISTS idx_product_modifier_groups_product ON product_modifier_groups(product_id);

-- Product additions: food-aware metadata + generic unit-of-sale
-- (unit_of_sale/quantity_step/min_order_quantity are NOT food-exclusive —
-- a general store selling by the yard/ml needs the same capability).
ALTER TABLE products
ADD COLUMN IF NOT EXISTS prep_time_minutes INTEGER,
ADD COLUMN IF NOT EXISTS is_available_today BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS available_branch_ids UUID[],
ADD COLUMN IF NOT EXISTS unit_of_sale VARCHAR(20) NOT NULL DEFAULT 'piece',
ADD COLUMN IF NOT EXISTS quantity_step DECIMAL(10, 3) NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS min_order_quantity DECIMAL(10, 3) NOT NULL DEFAULT 1;
