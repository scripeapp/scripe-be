-- Replace the per-store unit registry with one platform-owned catalog.
-- Products keep unit_id, but it now references a global unit definition.

CREATE TABLE IF NOT EXISTS units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('count', 'weight', 'volume', 'length', 'area', 'time')),
  conversion_factor NUMERIC(20, 8),
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_units_name_unique ON units (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_units_symbol_unique ON units (lower(symbol));
CREATE INDEX IF NOT EXISTS idx_units_type_sort ON units (type, sort_order, name);

DROP TRIGGER IF EXISTS units_set_updated_at ON units;
CREATE TRIGGER units_set_updated_at
BEFORE UPDATE ON units
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO units (code, name, symbol, type, conversion_factor, sort_order)
VALUES
  ('piece', 'Piece', 'pc', 'count', 1, 10),
  ('pack', 'Pack', 'pk', 'count', 1, 20),
  ('box', 'Box', 'box', 'count', 1, 30),
  ('carton', 'Carton', 'ctn', 'count', 1, 40),
  ('dozen', 'Dozen', 'dz', 'count', 12, 50),
  ('pair', 'Pair', 'pr', 'count', 2, 60),
  ('set', 'Set', 'set', 'count', 1, 70),
  ('serving', 'Serving', 'srv', 'count', 1, 80),
  ('portion', 'Portion', 'portion', 'count', 1, 90),
  ('item', 'Item', 'item', 'count', 1, 100),
  ('bottle', 'Bottle', 'btl', 'count', 1, 110),
  ('can', 'Can', 'can', 'count', 1, 120),
  ('jar', 'Jar', 'jar', 'count', 1, 130),
  ('bag', 'Bag', 'bag', 'count', 1, 140),
  ('kg', 'Kilogram', 'kg', 'weight', 1, 210),
  ('g', 'Gram', 'g', 'weight', 0.001, 220),
  ('mg', 'Milligram', 'mg', 'weight', 0.000001, 230),
  ('ton', 'Tonne', 't', 'weight', 1000, 240),
  ('lb', 'Pound', 'lb', 'weight', 0.45359237, 250),
  ('oz', 'Ounce', 'oz', 'weight', 0.0283495231, 260),
  ('liter', 'Litre', 'L', 'volume', 1, 310),
  ('ml', 'Millilitre', 'ml', 'volume', 0.001, 320),
  ('cl', 'Centilitre', 'cl', 'volume', 0.01, 330),
  ('gallon', 'Gallon', 'gal', 'volume', 3.785411784, 340),
  ('quart', 'Quart', 'qt', 'volume', 0.946352946, 350),
  ('pint', 'Pint', 'pt', 'volume', 0.473176473, 360),
  ('cup', 'Cup', 'cup', 'volume', 0.2365882365, 370),
  ('tbsp', 'Tablespoon', 'tbsp', 'volume', 0.0147867648, 380),
  ('tsp', 'Teaspoon', 'tsp', 'volume', 0.00492892159, 390),
  ('meter', 'Metre', 'm', 'length', 1, 410),
  ('cm', 'Centimetre', 'cm', 'length', 0.01, 420),
  ('mm', 'Millimetre', 'mm', 'length', 0.001, 430),
  ('km', 'Kilometre', 'km', 'length', 1000, 440),
  ('inch', 'Inch', 'in', 'length', 0.0254, 450),
  ('foot', 'Foot', 'ft', 'length', 0.3048, 460),
  ('yard', 'Yard', 'yd', 'length', 0.9144, 470),
  ('square-meter', 'Square metre', 'm²', 'area', 1, 510),
  ('square-foot', 'Square foot', 'ft²', 'area', 0.09290304, 520),
  ('hour', 'Hour', 'hr', 'time', 1, 610),
  ('minute', 'Minute', 'min', 'time', 0.0166666667, 620),
  ('day', 'Day', 'day', 'time', 24, 630)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  symbol = EXCLUDED.symbol,
  type = EXCLUDED.type,
  conversion_factor = EXCLUDED.conversion_factor,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_unit_id_fkey;

-- Re-link units created by the previous migration to the global catalog.
UPDATE products AS product
SET unit_id = global_unit.id
FROM store_units AS store_unit
JOIN units AS global_unit ON
  lower(global_unit.code) = lower(store_unit.code)
  OR lower(global_unit.name) = lower(store_unit.name)
  OR lower(global_unit.symbol) = lower(store_unit.symbol)
WHERE product.unit_id = store_unit.id;

UPDATE products AS product
SET unit_of_sale = global_unit.code
FROM units AS global_unit
WHERE product.unit_id = global_unit.id;

-- Also recover products that only stored the legacy text value.
UPDATE products AS product
SET unit_id = global_unit.id,
    unit_of_sale = global_unit.code
FROM units AS global_unit
WHERE product.unit_id IS NULL
  AND (
    lower(product.unit_of_sale) = lower(global_unit.code)
    OR lower(product.unit_of_sale) = lower(global_unit.name)
    OR lower(product.unit_of_sale) = lower(global_unit.symbol)
  );

ALTER TABLE products
ADD CONSTRAINT products_unit_id_fkey
FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE RESTRICT;

DROP TRIGGER IF EXISTS stores_seed_units_after_insert ON stores;
DROP FUNCTION IF EXISTS seed_units_for_new_store();
DROP FUNCTION IF EXISTS seed_store_units(UUID);
DROP FUNCTION IF EXISTS set_store_unit_default(UUID, UUID);
DROP FUNCTION IF EXISTS get_store_units_with_usage(UUID);
DROP POLICY IF EXISTS "Business members manage store units" ON store_units;
DROP TABLE IF EXISTS store_units;

ALTER TABLE stores DROP COLUMN IF EXISTS custom_units;

ALTER TABLE units ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON units TO authenticated, service_role;
DROP POLICY IF EXISTS "Authenticated users can read units" ON units;
CREATE POLICY "Authenticated users can read units" ON units
  FOR SELECT TO authenticated USING (is_active = true);

CREATE OR REPLACE FUNCTION get_units_with_usage(target_store_id UUID)
RETURNS TABLE (
  id UUID,
  code VARCHAR(20),
  name VARCHAR(100),
  symbol VARCHAR(20),
  type VARCHAR(20),
  conversion_factor NUMERIC(20, 8),
  is_active BOOLEAN,
  sort_order INTEGER,
  product_count BIGINT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    unit.id,
    unit.code,
    unit.name,
    unit.symbol,
    unit.type,
    unit.conversion_factor,
    unit.is_active,
    unit.sort_order,
    count(product.id) FILTER (WHERE product.store_id = target_store_id),
    unit.created_at,
    unit.updated_at
  FROM units AS unit
  LEFT JOIN products AS product ON product.unit_id = unit.id
  WHERE unit.is_active
  GROUP BY unit.id
  ORDER BY unit.sort_order, unit.name;
$$;

REVOKE ALL ON FUNCTION get_units_with_usage(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_units_with_usage(UUID) TO authenticated, service_role;
