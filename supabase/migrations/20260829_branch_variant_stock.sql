-- Normalize branch inventory overrides at one mixed grain:
--   variant_id IS NULL     -> whole-product balance for the branch
--   variant_id IS NOT NULL -> variant balance for the branch
--
-- This is intentionally separate from product_branch_overrides. That table
-- also stores catalog concerns (price, availability and lead time), so the
-- mere presence of one of its rows cannot mean that stock is overridden:
-- stock_quantity NULL must remain the unambiguous value "explicitly
-- unlimited", while an absent inventory row means "inherit".

CREATE UNIQUE INDEX IF NOT EXISTS product_variants_product_id_id_unique
  ON product_variants(product_id, id);

CREATE TABLE IF NOT EXISTS public.branch_inventory_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES store_branches(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id UUID NULL,
  stock_quantity INTEGER NULL,
  reserved_quantity INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT branch_inventory_product_variant_fk
    FOREIGN KEY (product_id, variant_id)
    REFERENCES product_variants(product_id, id)
    ON DELETE CASCADE,
  CONSTRAINT branch_inventory_stock_nonnegative
    CHECK (stock_quantity IS NULL OR stock_quantity >= 0),
  CONSTRAINT branch_inventory_reserved_nonnegative
    CHECK (reserved_quantity >= 0),
  CONSTRAINT branch_inventory_reserved_within_stock
    CHECK (stock_quantity IS NULL OR reserved_quantity <= stock_quantity),
  CONSTRAINT branch_inventory_override_unique
    UNIQUE NULLS NOT DISTINCT (branch_id, product_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_branch_inventory_product
  ON branch_inventory_overrides(product_id);
CREATE INDEX IF NOT EXISTS idx_branch_inventory_branch
  ON branch_inventory_overrides(branch_id);
CREATE INDEX IF NOT EXISTS idx_branch_inventory_variant
  ON branch_inventory_overrides(variant_id)
  WHERE variant_id IS NOT NULL;

-- No branch override balances exist yet, so there is no data backfill. The
-- IF EXISTS cleanup only removes columns from an environment that applied the
-- short-lived transitional schema before this migration was finalized.
ALTER TABLE product_branch_overrides
  DROP CONSTRAINT IF EXISTS product_branch_overrides_stock_nonnegative,
  DROP CONSTRAINT IF EXISTS product_branch_overrides_reserved_nonnegative,
  DROP COLUMN IF EXISTS stock_quantity,
  DROP COLUMN IF EXISTS reserved_quantity,
  DROP COLUMN IF EXISTS variant_stock;

ALTER TABLE branch_inventory_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Business members manage branch inventory overrides"
  ON branch_inventory_overrides;
CREATE POLICY "Business members manage branch inventory overrides"
  ON branch_inventory_overrides
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM products p
      JOIN stores s ON s.id = p.store_id
      WHERE p.id = branch_inventory_overrides.product_id
        AND is_business_member(s.business_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM products p
      JOIN stores s ON s.id = p.store_id
      JOIN store_branches b ON b.store_id = s.id
      WHERE p.id = branch_inventory_overrides.product_id
        AND b.id = branch_inventory_overrides.branch_id
        AND is_business_member(s.business_id)
    )
  );

DROP POLICY IF EXISTS "Public view branch inventory overrides"
  ON branch_inventory_overrides;
CREATE POLICY "Public view branch inventory overrides"
  ON branch_inventory_overrides
  FOR SELECT
  USING (true);

DROP TRIGGER IF EXISTS branch_inventory_overrides_set_updated_at
  ON branch_inventory_overrides;
CREATE TRIGGER branch_inventory_overrides_set_updated_at
BEFORE UPDATE ON branch_inventory_overrides
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- Replaces the transitional branch-only function from the preceding
-- migration. Named RPC arguments keep the application call stable.
DROP FUNCTION IF EXISTS decrement_product_stock(UUID, UUID, INTEGER, UUID, TEXT, UUID, UUID);
DROP FUNCTION IF EXISTS decrement_product_branch_stock(UUID, UUID, INTEGER);

CREATE OR REPLACE FUNCTION decrement_product_stock(
  p_product_id UUID,
  p_branch_id UUID,
  p_quantity INTEGER,
  p_variant_id UUID,
  p_reason TEXT,
  p_reference_id UUID,
  p_created_by UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_branch_stock INTEGER;
  v_branch_reserved INTEGER;
  v_product_stock INTEGER;
  v_variant_stock INTEGER;
  v_store_id UUID;
  v_used_branch BOOLEAN := FALSE;
  v_remaining INTEGER := NULL;
BEGIN
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be positive' USING ERRCODE = '22023';
  END IF;

  IF p_reason NOT IN ('sale', 'restock', 'adjustment', 'return') THEN
    RAISE EXCEPTION 'Invalid stock movement reason' USING ERRCODE = '22023';
  END IF;

  SELECT stock, store_id
    INTO v_product_stock, v_store_id
    FROM products
   WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM store_branches
     WHERE id = p_branch_id
       AND store_id = v_store_id
  ) THEN
    RAISE EXCEPTION 'Branch does not belong to product store'
      USING ERRCODE = '23503';
  END IF;

  IF p_variant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM product_variants
     WHERE id = p_variant_id
       AND product_id = p_product_id
  ) THEN
    RAISE EXCEPTION 'Variant does not belong to product' USING ERRCODE = '23503';
  END IF;

  -- Most-specific branch row wins. A present NULL balance is explicitly
  -- unlimited and stops fallback; only a missing row inherits.
  IF p_branch_id IS NOT NULL AND p_variant_id IS NOT NULL THEN
    SELECT stock_quantity, reserved_quantity
      INTO v_branch_stock, v_branch_reserved
      FROM branch_inventory_overrides
     WHERE branch_id = p_branch_id
       AND product_id = p_product_id
       AND variant_id = p_variant_id
     FOR UPDATE;

    IF FOUND THEN
      v_used_branch := TRUE;
      IF v_branch_stock IS NOT NULL THEN
        IF v_branch_stock - v_branch_reserved < p_quantity THEN
          RAISE EXCEPTION 'Insufficient branch variant stock'
            USING ERRCODE = 'P0001';
        END IF;
        v_remaining := v_branch_stock - p_quantity;
        UPDATE branch_inventory_overrides
           SET stock_quantity = v_remaining
         WHERE branch_id = p_branch_id
           AND product_id = p_product_id
           AND variant_id = p_variant_id;
      END IF;
    END IF;
  END IF;

  IF p_branch_id IS NOT NULL AND NOT v_used_branch THEN
    SELECT stock_quantity, reserved_quantity
      INTO v_branch_stock, v_branch_reserved
      FROM branch_inventory_overrides
     WHERE branch_id = p_branch_id
       AND product_id = p_product_id
       AND variant_id IS NULL
     FOR UPDATE;

    IF FOUND THEN
      v_used_branch := TRUE;
      IF v_branch_stock IS NOT NULL THEN
        IF v_branch_stock - v_branch_reserved < p_quantity THEN
          RAISE EXCEPTION 'Insufficient branch stock' USING ERRCODE = 'P0001';
        END IF;
        v_remaining := v_branch_stock - p_quantity;
        UPDATE branch_inventory_overrides
           SET stock_quantity = v_remaining
         WHERE branch_id = p_branch_id
           AND product_id = p_product_id
           AND variant_id IS NULL;
      END IF;
    END IF;
  END IF;

  -- No branch inventory row: inherit global inventory. Product and variant
  -- balances are both caps when both are tracked, preserving existing
  -- checkout semantics.
  IF NOT v_used_branch THEN
    SELECT stock
      INTO v_product_stock
      FROM products
     WHERE id = p_product_id
     FOR UPDATE;

    IF p_variant_id IS NOT NULL THEN
      SELECT stock
        INTO v_variant_stock
        FROM product_variants
       WHERE id = p_variant_id
         AND product_id = p_product_id
       FOR UPDATE;

      IF v_variant_stock IS NOT NULL THEN
        IF v_variant_stock < p_quantity THEN
          RAISE EXCEPTION 'Insufficient stock' USING ERRCODE = 'P0001';
        END IF;
        UPDATE product_variants
           SET stock = v_variant_stock - p_quantity
         WHERE id = p_variant_id;
        v_remaining := v_variant_stock - p_quantity;
      END IF;
    END IF;

    IF v_product_stock IS NOT NULL THEN
      IF v_product_stock < p_quantity THEN
        RAISE EXCEPTION 'Insufficient stock' USING ERRCODE = 'P0001';
      END IF;
      UPDATE products
         SET stock = v_product_stock - p_quantity
       WHERE id = p_product_id;
      v_remaining := v_product_stock - p_quantity;
    END IF;
  END IF;

  INSERT INTO stock_movements
    (store_id, product_id, variant_id, branch_id, quantity_change, reason,
     reference_id, created_by)
  VALUES
    (v_store_id, p_product_id, p_variant_id,
     CASE WHEN v_used_branch THEN p_branch_id ELSE NULL END,
     -p_quantity, p_reason, p_reference_id, p_created_by);

  RETURN v_remaining;
END;
$$;

REVOKE ALL ON FUNCTION decrement_product_stock(UUID, UUID, INTEGER, UUID, TEXT, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION decrement_product_stock(UUID, UUID, INTEGER, UUID, TEXT, UUID, UUID)
  TO service_role;

COMMENT ON TABLE branch_inventory_overrides IS
  'Sparse branch inventory overrides. variant_id NULL is the whole-product branch balance; non-NULL is a variant balance. Row absence inherits global stock; a present NULL stock_quantity is unlimited.';
