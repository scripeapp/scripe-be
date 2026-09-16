-- ============================================================================
-- Unified Product-Module Links
--
-- Replaces the single-purpose `product_circle_links` table with a generic
-- linking table that allows any store product to be a facade for an entity
-- in any platform module (circles, publications, forms, event_types, …).
--
-- module_type identifies the source module; entity_id references the primary
-- key of that module's main table; config stores module-specific settings
-- (e.g. default_plan_id, allow_tier_selection for circles).
-- ============================================================================

-- 1. Create the unified table
CREATE TABLE IF NOT EXISTS product_module_links (
  product_id  UUID        PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  module_type TEXT        NOT NULL,
  entity_id   UUID        NOT NULL,
  config      JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pml_valid_module_type CHECK (
    module_type IN ('circle', 'publication', 'form', 'event_type')
  )
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_pml_module_entity
  ON product_module_links (module_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_pml_entity_id
  ON product_module_links (entity_id);

-- 2. Migrate existing circle links into the new table
INSERT INTO product_module_links (product_id, module_type, entity_id, config, created_at, updated_at)
SELECT
  product_id,
  'circle',
  circle_id,
  jsonb_build_object(
    'default_plan_id', default_plan_id,
    'allow_tier_selection', COALESCE(allow_tier_selection, false)
  ),
  created_at,
  updated_at
FROM product_circle_links
ON CONFLICT (product_id) DO NOTHING;

-- 3. RLS policies
ALTER TABLE product_module_links ENABLE ROW LEVEL SECURITY;

-- Store owners can manage links for their products
CREATE POLICY pml_owner_all ON product_module_links
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM products p
      JOIN stores s ON s.id = p.store_id
      WHERE p.id = product_module_links.product_id
        AND s.user_id = auth.uid()
    )
  );

-- Public read access (needed for storefront rendering)
CREATE POLICY pml_public_read ON product_module_links
  FOR SELECT
  USING (true);

-- 4. Updated_at trigger
CREATE OR REPLACE FUNCTION update_pml_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_pml_updated_at
  BEFORE UPDATE ON product_module_links
  FOR EACH ROW
  EXECUTE FUNCTION update_pml_updated_at();
