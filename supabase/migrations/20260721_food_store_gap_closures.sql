-- Food Store gap closures identified from a real-world "kitchen JSON" import
-- test (Maplewood Kitchen & Tap): expands fulfilment types from 2 to 4,
-- adds a description field to modifier groups, and adds an
-- utensils-requested flag on orders. See conversation notes for the full
-- gap list — table/seating management, tax/gratuity, combos, and gift
-- cards/loyalty points are deliberately NOT addressed here (separate,
-- larger phases).

-- 1. Expand operation_types / fulfillment_type from walk_in|delivery to
-- dine_in|takeout|delivery|curbside. Existing 'walk_in' rows are
-- reinterpreted as 'takeout' (closest equivalent — the old value meant
-- "customer collects in person", which "takeout" already covers).
UPDATE store_branches
SET operation_types = array_replace(operation_types, 'walk_in', 'takeout')
WHERE 'walk_in' = ANY(operation_types);

UPDATE store_orders
SET fulfillment_type = 'takeout'
WHERE fulfillment_type = 'walk_in';

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

ALTER TABLE store_branches
ADD CONSTRAINT store_branches_operation_types_check
  CHECK (
    cardinality(operation_types) > 0
    AND operation_types <@ ARRAY['dine_in', 'takeout', 'delivery', 'curbside']::TEXT[]
  );

ALTER TABLE store_orders
ADD CONSTRAINT store_orders_fulfillment_type_check
  CHECK (fulfillment_type IN ('dine_in', 'takeout', 'delivery', 'curbside'));

-- 2. Modifier group free-text note (e.g. "Max 2 sauces, split evenly") —
-- shown alongside the numeric min/max rule, doesn't replace it.
ALTER TABLE modifier_groups
ADD COLUMN IF NOT EXISTS description TEXT;

-- 3. Utensils-requested flag on orders (relevant mainly for delivery).
ALTER TABLE store_orders
ADD COLUMN IF NOT EXISTS utensils_requested BOOLEAN NOT NULL DEFAULT false;
