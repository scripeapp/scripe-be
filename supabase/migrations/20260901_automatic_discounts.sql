-- Promote discount_codes into a shared code/automatic discount store while
-- preserving every existing record as a code discount.
ALTER TABLE discount_codes
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'code',
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS trigger text,
  ADD COLUMN IF NOT EXISTS trigger_value numeric(12, 2),
  ADD COLUMN IF NOT EXISTS qualification_product_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS allow_code_on_top boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_on_storefront boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS one_use_per_customer boolean NOT NULL DEFAULT false;

ALTER TABLE discount_codes
  ALTER COLUMN code DROP NOT NULL;

ALTER TABLE discount_codes
  DROP CONSTRAINT IF EXISTS discount_codes_store_id_code_key,
  DROP CONSTRAINT IF EXISTS discount_codes_kind_check,
  DROP CONSTRAINT IF EXISTS discount_codes_trigger_check,
  DROP CONSTRAINT IF EXISTS discount_codes_kind_fields_check,
  DROP CONSTRAINT IF EXISTS discount_codes_trigger_value_check,
  DROP CONSTRAINT IF EXISTS discount_codes_date_range_check,
  DROP CONSTRAINT IF EXISTS discount_codes_value_check,
  DROP CONSTRAINT IF EXISTS discount_codes_product_scope_check,
  DROP CONSTRAINT IF EXISTS discount_codes_qualification_products_check;

ALTER TABLE discount_codes
  ADD CONSTRAINT discount_codes_kind_check
    CHECK (kind IN ('code', 'automatic')),
  ADD CONSTRAINT discount_codes_trigger_check
    CHECK (
      trigger IS NULL OR trigger IN (
        'spend_threshold',
        'quantity_bought',
        'specific_products',
        'first_order'
      )
    ),
  ADD CONSTRAINT discount_codes_kind_fields_check
    CHECK (
      (kind = 'code' AND code IS NOT NULL AND length(trim(code)) > 0)
      OR
      (kind = 'automatic' AND code IS NULL AND name IS NOT NULL
        AND length(trim(name)) > 0 AND trigger IS NOT NULL)
    ),
  ADD CONSTRAINT discount_codes_trigger_value_check
    CHECK (
      kind = 'code'
      OR trigger IN ('specific_products', 'first_order')
      OR (trigger_value IS NOT NULL AND trigger_value > 0)
    ),
  ADD CONSTRAINT discount_codes_value_check
    CHECK (value > 0 AND (type <> 'percentage' OR value <= 100)),
  ADD CONSTRAINT discount_codes_product_scope_check
    CHECK (applies_to <> 'specific' OR cardinality(product_ids) > 0),
  ADD CONSTRAINT discount_codes_qualification_products_check
    CHECK (
      kind <> 'automatic'
      OR trigger <> 'specific_products'
      OR cardinality(qualification_product_ids) > 0
    ),
  ADD CONSTRAINT discount_codes_date_range_check
    CHECK (expires_at IS NULL OR starts_at IS NULL OR expires_at > starts_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_codes_store_code_unique
  ON discount_codes (store_id, upper(code))
  WHERE code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_discount_codes_store_kind_active
  ON discount_codes (store_id, kind, is_active);

CREATE INDEX IF NOT EXISTS idx_discount_codes_qualification_products
  ON discount_codes USING GIN (qualification_product_ids);

CREATE TABLE IF NOT EXISTS discount_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discount_id uuid NOT NULL REFERENCES discount_codes(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  customer_email text,
  amount numeric(12, 2) NOT NULL CHECK (amount >= 0),
  currency text NOT NULL DEFAULT 'NGN',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (discount_id, order_id)
);

CREATE INDEX IF NOT EXISTS idx_discount_redemptions_customer
  ON discount_redemptions (discount_id, lower(customer_email))
  WHERE customer_email IS NOT NULL;

ALTER TABLE discount_redemptions ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION record_discount_redemption(
  p_discount_id uuid,
  p_store_id uuid,
  p_order_id uuid,
  p_customer_email text,
  p_amount numeric,
  p_currency text DEFAULT 'NGN'
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  discount_row discount_codes%ROWTYPE;
  inserted_id uuid;
BEGIN
  SELECT * INTO discount_row
  FROM discount_codes
  WHERE id = p_discount_id AND store_id = p_store_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Discount not found';
  END IF;

  IF discount_row.max_usage IS NOT NULL
    AND discount_row.usage_count >= discount_row.max_usage THEN
    RETURN false;
  END IF;

  IF discount_row.one_use_per_customer
    AND p_customer_email IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM discount_redemptions
      WHERE discount_id = p_discount_id
        AND lower(customer_email) = lower(p_customer_email)
    ) THEN
    RETURN false;
  END IF;

  INSERT INTO discount_redemptions (
    discount_id,
    store_id,
    order_id,
    customer_email,
    amount,
    currency
  ) VALUES (
    p_discount_id,
    p_store_id,
    p_order_id,
    lower(p_customer_email),
    p_amount,
    p_currency
  )
  ON CONFLICT (discount_id, order_id) DO NOTHING
  RETURNING id INTO inserted_id;

  IF inserted_id IS NULL THEN
    RETURN true;
  END IF;

  UPDATE discount_codes
  SET usage_count = usage_count + 1,
      updated_at = now()
  WHERE id = p_discount_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION record_discount_redemption(
  uuid, uuid, uuid, text, numeric, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_discount_redemption(
  uuid, uuid, uuid, text, numeric, text
) TO service_role;

DROP POLICY IF EXISTS "Business members can view discount redemptions"
  ON discount_redemptions;
CREATE POLICY "Business members can view discount redemptions"
  ON discount_redemptions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM stores store
      WHERE store.id = discount_redemptions.store_id
        AND store.business_id IN (
          SELECT business_id
          FROM memberships
          WHERE user_id = auth.uid()
            AND status = 'active'
        )
    )
  );

COMMENT ON COLUMN discount_codes.value IS
  'Percentage points for percentage discounts; minor currency units for fixed discounts.';
COMMENT ON COLUMN discount_codes.trigger_value IS
  'Minor currency units for spend_threshold; whole item count for quantity_bought.';
