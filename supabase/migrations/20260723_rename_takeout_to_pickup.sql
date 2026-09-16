-- Rename the 'takeout' fulfilment type to 'pickup' — "takeout" isn't the
-- natural term for Nigerian merchants/customers; "pickup" is. Same rename
-- pattern as 20260721 (walk_in → takeout), but constraints are dropped
-- BEFORE rewriting values: the old CHECK only allows 'takeout', so
-- writing 'pickup' while it's still active fails with 23514.

-- 1. Drop old constraints (by definition match — names vary across
-- environments).
DO $$
DECLARE
  con record;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'store_branches'::regclass
      AND pg_get_constraintdef(oid) LIKE '%operation_types%'
  LOOP
    EXECUTE format('ALTER TABLE store_branches DROP CONSTRAINT %I', con.conname);
  END LOOP;

  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'store_orders'::regclass
      AND pg_get_constraintdef(oid) LIKE '%fulfillment_type%'
  LOOP
    EXECUTE format('ALTER TABLE store_orders DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

-- 2. Stored values.
UPDATE store_branches
SET operation_types = array_replace(operation_types, 'takeout', 'pickup')
WHERE 'takeout' = ANY(operation_types);

UPDATE store_orders
SET fulfillment_type = 'pickup'
WHERE fulfillment_type = 'takeout';

-- service_charge_rates is JSONB keyed by fulfilment type ('{"dine_in": 5,
-- "takeout": 0, ...}') — move the takeout key to pickup where present.
UPDATE store_branches
SET service_charge_rates =
  (service_charge_rates - 'takeout')
  || jsonb_build_object('pickup', service_charge_rates -> 'takeout')
WHERE service_charge_rates ? 'takeout';

-- 3. New constraints.
ALTER TABLE store_branches
ADD CONSTRAINT store_branches_operation_types_check
  CHECK (
    cardinality(operation_types) > 0
    AND operation_types <@ ARRAY['dine_in', 'pickup', 'delivery', 'curbside']::TEXT[]
  );

ALTER TABLE store_orders
ADD CONSTRAINT store_orders_fulfillment_type_check
  CHECK (fulfillment_type IN ('dine_in', 'pickup', 'delivery', 'curbside'));

-- 4. Fix a latent bug while we're here: the column default was still
-- ARRAY['walk_in'] from 20260720 — a value the constraint has disallowed
-- since 20260721, so any insert relying on the default would have failed.
ALTER TABLE store_branches
ALTER COLUMN operation_types SET DEFAULT ARRAY['pickup']::TEXT[];
