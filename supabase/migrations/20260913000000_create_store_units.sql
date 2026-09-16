-- Canonical units of sale. Products retain unit_of_sale during the transition
-- so older clients keep working, while unit_id provides a stable relationship.
CREATE TABLE IF NOT EXISTS store_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(100) NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('count', 'weight', 'volume')),
  is_system BOOLEAN NOT NULL DEFAULT false,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, code)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_store_units_name_unique
  ON store_units (store_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_store_units_symbol_unique
  ON store_units (store_id, lower(symbol));
CREATE UNIQUE INDEX IF NOT EXISTS idx_store_units_default_per_type
  ON store_units (store_id, type)
  WHERE is_default AND is_enabled;
CREATE INDEX IF NOT EXISTS idx_store_units_store_id
  ON store_units (store_id);

ALTER TABLE store_units ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Business members manage store units" ON store_units;
CREATE POLICY "Business members manage store units" ON store_units
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM stores AS store
      WHERE store.id = store_units.store_id
        AND is_business_member(store.business_id)
    )
  );

DROP TRIGGER IF EXISTS store_units_set_updated_at ON store_units;
CREATE TRIGGER store_units_set_updated_at
BEFORE UPDATE ON store_units
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE products
ADD COLUMN IF NOT EXISTS unit_id UUID REFERENCES store_units(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_products_unit_id ON products(unit_id);

CREATE OR REPLACE FUNCTION seed_store_units(target_store_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO store_units (store_id, code, name, symbol, type, is_system, is_default)
  VALUES
    (target_store_id, 'kg', 'Kilogram', 'kg', 'weight', true, true),
    (target_store_id, 'g', 'Gram', 'g', 'weight', true, false),
    (target_store_id, 'liter', 'Litre', 'L', 'volume', true, true),
    (target_store_id, 'ml', 'Millilitre', 'ml', 'volume', true, false),
    (target_store_id, 'piece', 'Piece', 'pc', 'count', true, true),
    (target_store_id, 'pack', 'Pack', 'pk', 'count', true, false),
    (target_store_id, 'carton', 'Carton', 'ctn', 'count', true, false),
    (target_store_id, 'dozen', 'Dozen', 'dz', 'count', true, false),
    (target_store_id, 'cup', 'Cup', 'cup', 'volume', true, false)
  ON CONFLICT (store_id, code) DO NOTHING;
END;
$$;

DO $$
DECLARE
  store_record RECORD;
BEGIN
  FOR store_record IN SELECT id FROM stores LOOP
    PERFORM seed_store_units(store_record.id);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION seed_units_for_new_store()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM seed_store_units(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stores_seed_units_after_insert ON stores;
CREATE TRIGGER stores_seed_units_after_insert
AFTER INSERT ON stores
FOR EACH ROW EXECUTE FUNCTION seed_units_for_new_store();

-- Migrate legacy plain-string custom units. Structured JSON strings are
-- handled separately below so deployments that briefly shipped that format
-- remain recoverable.
INSERT INTO store_units (store_id, code, name, symbol, type, is_system)
SELECT
  store.id,
  left(regexp_replace(lower(trim(entry)), '[^a-z0-9]+', '-', 'g'), 20),
  left(trim(entry), 100),
  left(trim(entry), 20),
  'count',
  false
FROM stores AS store
CROSS JOIN LATERAL unnest(COALESCE(store.custom_units, ARRAY[]::TEXT[])) AS entry
WHERE trim(entry) <> ''
  AND regexp_replace(lower(trim(entry)), '[^a-z0-9]+', '-', 'g') <> ''
  AND left(ltrim(entry), 1) <> '{'
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  store_record RECORD;
  raw_unit TEXT;
  parsed_unit JSONB;
  unit_code TEXT;
BEGIN
  FOR store_record IN SELECT id, custom_units FROM stores LOOP
    FOREACH raw_unit IN ARRAY COALESCE(store_record.custom_units, ARRAY[]::TEXT[]) LOOP
      IF left(ltrim(raw_unit), 1) <> '{' THEN
        CONTINUE;
      END IF;

      BEGIN
        parsed_unit := raw_unit::JSONB;
        IF COALESCE(trim(parsed_unit->>'name'), '') = '' OR
           COALESCE(trim(parsed_unit->>'symbol'), '') = '' THEN
          CONTINUE;
        END IF;

        unit_code := COALESCE(
          NULLIF(trim(parsed_unit->>'id'), ''),
          regexp_replace(lower(trim(parsed_unit->>'name')), '[^a-z0-9]+', '-', 'g')
        );
        unit_code := left(regexp_replace(unit_code, '^unit-', ''), 20);

        INSERT INTO store_units (
          store_id,
          code,
          name,
          symbol,
          type,
          is_system,
          is_default
        ) VALUES (
          store_record.id,
          unit_code,
          left(trim(parsed_unit->>'name'), 100),
          left(trim(parsed_unit->>'symbol'), 20),
          CASE
            WHEN parsed_unit->>'type' IN ('count', 'weight', 'volume')
              THEN parsed_unit->>'type'
            ELSE 'count'
          END,
          COALESCE((parsed_unit->>'is_custom')::BOOLEAN, true) = false,
          COALESCE((parsed_unit->>'is_default')::BOOLEAN, false)
        )
        ON CONFLICT DO NOTHING;
      EXCEPTION WHEN OTHERS THEN
        CONTINUE;
      END;
    END LOOP;
  END LOOP;
END;
$$;

UPDATE products AS product
SET unit_id = unit.id
FROM store_units AS unit
WHERE product.unit_id IS NULL
  AND product.store_id = unit.store_id
  AND (
    lower(trim(product.unit_of_sale)) = lower(unit.code) OR
    lower(trim(product.unit_of_sale)) = lower(unit.name) OR
    lower(trim(product.unit_of_sale)) = lower(unit.symbol) OR
    (lower(trim(product.unit_of_sale)) = 'litre' AND unit.code = 'liter')
  );

UPDATE products AS product
SET unit_of_sale = unit.code
FROM store_units AS unit
WHERE product.unit_id = unit.id;

CREATE OR REPLACE FUNCTION set_store_unit_default(
  target_store_id UUID,
  target_unit_id UUID
)
RETURNS store_units
LANGUAGE plpgsql
AS $$
DECLARE
  target_type VARCHAR(20);
  selected_unit store_units;
BEGIN
  SELECT type INTO target_type
  FROM store_units
  WHERE id = target_unit_id
    AND store_id = target_store_id
    AND is_enabled;

  IF target_type IS NULL THEN
    RAISE EXCEPTION 'Unit not found or disabled';
  END IF;

  UPDATE store_units
  SET is_default = false
  WHERE store_id = target_store_id
    AND type = target_type
    AND is_default;

  UPDATE store_units
  SET is_default = true
  WHERE id = target_unit_id
    AND store_id = target_store_id
  RETURNING * INTO selected_unit;

  RETURN selected_unit;
END;
$$;

CREATE OR REPLACE FUNCTION get_store_units_with_usage(target_store_id UUID)
RETURNS TABLE (
  id UUID,
  store_id UUID,
  code VARCHAR(64),
  name VARCHAR(100),
  symbol VARCHAR(20),
  type VARCHAR(20),
  is_system BOOLEAN,
  is_enabled BOOLEAN,
  is_default BOOLEAN,
  product_count BIGINT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    unit.id,
    unit.store_id,
    unit.code,
    unit.name,
    unit.symbol,
    unit.type,
    unit.is_system,
    unit.is_enabled,
    unit.is_default,
    count(product.id) AS product_count,
    unit.created_at,
    unit.updated_at
  FROM store_units AS unit
  LEFT JOIN products AS product ON product.unit_id = unit.id
  WHERE unit.store_id = target_store_id
    AND unit.is_enabled
  GROUP BY unit.id
  ORDER BY unit.type, unit.name;
$$;

REVOKE ALL ON FUNCTION seed_store_units(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_store_unit_default(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_store_units_with_usage(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_store_unit_default(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_store_units_with_usage(UUID) TO authenticated, service_role;
