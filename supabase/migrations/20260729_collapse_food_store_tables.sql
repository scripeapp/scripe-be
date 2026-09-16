-- Collapses 4 tables into their parent tables:
--
-- 1. modifier_options  → JSONB options[]   on modifier_groups
-- 2. store_qr_codes    → JSONB qr_codes[]  on store_branches
-- 3. store_menus       → store_categories  (is_menu = true, parent_id self-ref)
-- 4. store_delivery_zones → store_delivery_methods (is_zone = true)

-- ============================================================
-- CASE 1: modifier_options → modifier_groups.options JSONB
-- ============================================================

ALTER TABLE modifier_groups
  ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '[]'::JSONB;

-- Aggregate each group's options into the JSONB column, preserving order.
UPDATE modifier_groups mg
SET options = (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',                mo.id,
        'modifier_group_id', mo.modifier_group_id,
        'name',              mo.name,
        'price_delta',       mo.price_delta,
        'is_available',      mo.is_available,
        'is_default',        mo.is_default,
        'position',          mo.position,
        'branch_ids',        mo.branch_ids,
        'created_at',        mo.created_at,
        'updated_at',        mo.updated_at
      )
      ORDER BY mo.position, mo.created_at
    ),
    '[]'::JSONB
  )
  FROM modifier_options mo
  WHERE mo.modifier_group_id = mg.id
);

DROP TABLE IF EXISTS modifier_options;

-- ============================================================
-- CASE 2: store_qr_codes → store_branches.qr_codes JSONB
-- ============================================================

ALTER TABLE store_branches
  ADD COLUMN IF NOT EXISTS qr_codes JSONB NOT NULL DEFAULT '[]'::JSONB;

-- Aggregate each branch's QR codes into the JSONB column.
UPDATE store_branches sb
SET qr_codes = (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',         qr.id,
        'store_id',   qr.store_id,
        'branch_id',  qr.branch_id,
        'label',      qr.label,
        'code',       qr.code,
        'is_active',  qr.is_active,
        'created_at', qr.created_at,
        'updated_at', qr.updated_at
      )
      ORDER BY qr.created_at
    ),
    '[]'::JSONB
  )
  FROM store_qr_codes qr
  WHERE qr.branch_id = sb.id
);

-- Drop the FK from store_orders before dropping the table.
ALTER TABLE store_orders
  DROP COLUMN IF EXISTS qr_code_id;

DROP TABLE IF EXISTS store_qr_codes;

-- ============================================================
-- CASE 3: store_menus → store_categories (is_menu / parent_id)
-- ============================================================

ALTER TABLE store_categories
  ADD COLUMN IF NOT EXISTS parent_id   UUID    REFERENCES store_categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_menu     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS availability JSONB  NULL,
  ADD COLUMN IF NOT EXISTS branch_ids  UUID[]  NULL;

CREATE INDEX IF NOT EXISTS idx_store_categories_parent ON store_categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_store_categories_is_menu ON store_categories(store_id, is_menu);

-- Insert each store_menus row as a category row with is_menu = true,
-- keeping the same id so the next UPDATE can reference it.
INSERT INTO store_categories (
  id, store_id, name, slug, description,
  position, is_active, is_menu, availability, branch_ids,
  created_at, updated_at
)
SELECT
  id, store_id,
  -- Append ' (Menu)' / '-menu' to avoid collisions with existing category
  -- name+slug unique constraints when a store has both a "Breakfast" category
  -- and a "Breakfast" menu.
  name || ' (Menu)',
  lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')) || '-menu',
  description,
  position, is_active,
  true,          -- is_menu
  availability,
  branch_ids,
  created_at, updated_at
FROM store_menus
ON CONFLICT (id) DO NOTHING;

-- Reparent child categories: menu_id → parent_id.
ALTER TABLE store_categories
  ADD COLUMN IF NOT EXISTS _menu_id_tmp UUID;

UPDATE store_categories sc
SET _menu_id_tmp = sc.menu_id
WHERE sc.menu_id IS NOT NULL;

UPDATE store_categories sc
SET parent_id = sc._menu_id_tmp
WHERE sc._menu_id_tmp IS NOT NULL;

ALTER TABLE store_categories DROP COLUMN IF EXISTS _menu_id_tmp;
ALTER TABLE store_categories DROP COLUMN IF EXISTS menu_id;

DROP TABLE IF EXISTS store_menus;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- CASE 4: store_delivery_zones → store_delivery_methods (is_zone)
-- ============================================================

ALTER TABLE store_delivery_methods
  ADD COLUMN IF NOT EXISTS is_zone          BOOLEAN      NULL,
  ADD COLUMN IF NOT EXISTS branch_id        UUID         REFERENCES store_branches(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS zip_code         VARCHAR(60)  NULL,
  ADD COLUMN IF NOT EXISTS min_order        INTEGER      NULL,
  ADD COLUMN IF NOT EXISTS estimated_minutes INTEGER     NULL;

CREATE INDEX IF NOT EXISTS idx_store_delivery_methods_zone
  ON store_delivery_methods(store_id, branch_id, zip_code)
  WHERE is_zone = true;

-- Copy zone rows into store_delivery_methods.
-- fee maps to price; zone rows have no name from the zone table so we
-- use the zip_code as the name (label-only, not customer-facing).
INSERT INTO store_delivery_methods (
  id, store_id, name, description,
  price, currency,
  is_active, sort_order,
  is_zone, branch_id, zip_code, min_order, estimated_minutes,
  created_at, updated_at
)
SELECT
  id, store_id,
  COALESCE(zip_code, 'Zone'),  -- name
  NULL,                         -- description
  fee,                          -- price
  currency,
  is_active,
  0,                            -- sort_order (zones aren't sorted the same way)
  true,                         -- is_zone
  branch_id,
  zip_code,
  min_order,
  estimated_minutes,
  created_at, updated_at
FROM store_delivery_zones
ON CONFLICT (id) DO NOTHING;

DROP TABLE IF EXISTS store_delivery_zones;

NOTIFY pgrst, 'reload schema';
