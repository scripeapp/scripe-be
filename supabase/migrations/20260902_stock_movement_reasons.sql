-- Widen the set of stock-movement reasons so specific causes are queryable
-- end-to-end instead of being folded into a single "adjustment" value with the
-- real cause buried in free-text notes.
--
-- Migration notes:
--   * The original inline CHECK in 20260113_stock_movements.sql was
--     auto-named `stock_movements_reason_check`; drop it by name and re-add a
--     named constraint so future changes are deterministic.
--   * `decrement_product_stock` enforces the same allow-list inline; keep it in
--     sync so checkout (and the upcoming transfer/count paths) never hit a
--     stale literal under the new constraint.
ALTER TABLE stock_movements
  DROP CONSTRAINT IF EXISTS stock_movements_reason_check;

ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_reason_check
  CHECK (
    reason IN (
      'sale',
      'return',
      'restock',
      'received',
      'damaged',
      'spoilage',
      'expired',
      'theft',
      'shrinkage',
      'found',
      'count',
      'transfer_out',
      'transfer_in',
      'adjustment'
    )
  );

-- Keep decrement_product_stock's inline reason guard aligned with the column
-- constraint above (it is recreated in whole by this function definition).
CREATE OR REPLACE FUNCTION public.decrement_product_stock(
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

  IF p_reason NOT IN ('sale', 'restock', 'adjustment', 'return', 'received', 'damaged',
                      'spoilage', 'expired', 'theft', 'shrinkage', 'found', 'count',
                      'transfer_out', 'transfer_in') THEN
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