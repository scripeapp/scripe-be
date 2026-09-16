-- A purchase order's lifecycle is a series of layered milestones — created,
-- sent to the supplier, received — and each keeps its own identity. The
-- single `status` column only holds the current state, so receiving a sent
-- order previously erased the "sent" milestone: no sent_at anywhere to say
-- when the supplier was actually notified. This adds explicit milestone
-- timestamps so the sent/received stages stack on top of earlier ones
-- instead of overwriting them.

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;

-- Backfill: anything already past draft must have been sent at some point.
-- created_at is the earliest defensible guess for orders that predate this
-- migration. Fully-received orders get updated_at (no earlier marker exists).
UPDATE purchase_orders
SET sent_at = created_at
WHERE sent_at IS NULL AND status IN ('sent', 'partially_received', 'received');

UPDATE purchase_orders
SET received_at = updated_at
WHERE received_at IS NULL AND status = 'received';

-- Re-create create_completed_stock_receipt with the received_at stamping
-- folded in, so the change reaches databases that already ran
-- 20260907_purchase_order_receiving_linkage.sql. The argument list is
-- unchanged, so CREATE OR REPLACE still works.
CREATE OR REPLACE FUNCTION create_completed_stock_receipt(
  p_store_id UUID,
  p_supplier_id UUID,
  p_branch_id UUID,
  p_received_at TIMESTAMPTZ,
  p_received_by UUID,
  p_notes TEXT,
  p_lines JSONB,
  p_purchase_order_id UUID DEFAULT NULL
)
RETURNS stock_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_receipt stock_receipts%ROWTYPE;
  v_line JSONB;
  v_line_id UUID;
  v_product products%ROWTYPE;
  v_variant_stock INTEGER;
  v_quantity INTEGER;
  v_unit_cost NUMERIC;
  v_subtotal NUMERIC := 0;
  v_tax NUMERIC := 0;
  v_discount NUMERIC := 0;
  v_po_line_id UUID;
  v_po_line_ordered INTEGER;
  v_po_line_received INTEGER;
  v_po_total_ordered INTEGER;
  v_po_total_received INTEGER;
BEGIN
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'At least one receipt line is required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier_id AND store_id = p_store_id) THEN
    RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM store_branches WHERE id = p_branch_id AND store_id = p_store_id
  ) THEN
    RAISE EXCEPTION 'Branch not found in this store' USING ERRCODE = '23503';
  END IF;
  IF p_purchase_order_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM purchase_orders
    WHERE id = p_purchase_order_id AND store_id = p_store_id AND supplier_id = p_supplier_id
  ) THEN
    RAISE EXCEPTION 'Purchase order not found for this supplier' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO stock_receipts (
    store_id, supplier_id, branch_id, purchase_order_id, status, received_at, received_by, notes
  ) VALUES (
    p_store_id, p_supplier_id, p_branch_id, p_purchase_order_id, 'completed',
    COALESCE(p_received_at, now()), p_received_by, p_notes
  ) RETURNING * INTO v_receipt;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    v_quantity := COALESCE((v_line ->> 'quantity_received')::INTEGER, 0);
    v_unit_cost := COALESCE((v_line ->> 'unit_cost')::NUMERIC, 0);

    IF v_line ->> 'product_id' IS NOT NULL THEN
      SELECT * INTO v_product FROM products
      WHERE id = (v_line ->> 'product_id')::UUID AND store_id = p_store_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Receipt product not found in this store' USING ERRCODE = 'P0002';
      END IF;
      IF v_line ->> 'variant_id' IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM product_variants
        WHERE id = (v_line ->> 'variant_id')::UUID AND product_id = v_product.id
      ) THEN
        RAISE EXCEPTION 'Receipt variant does not belong to product' USING ERRCODE = '23503';
      END IF;
    END IF;

    INSERT INTO stock_receipt_lines (
      stock_receipt_id, product_id, variant_id, purchase_order_line_id, description,
      quantity_received, quantity_rejected, rejection_reason, unit_cost,
      tax_rate, discount, batch_number, expiry_date, manufacture_date,
      serial_number, notes
    ) VALUES (
      v_receipt.id,
      NULLIF(v_line ->> 'product_id', '')::UUID,
      NULLIF(v_line ->> 'variant_id', '')::UUID,
      NULLIF(v_line ->> 'purchase_order_line_id', '')::UUID,
      NULLIF(BTRIM(v_line ->> 'description'), ''),
      v_quantity,
      COALESCE((v_line ->> 'quantity_rejected')::INTEGER, 0),
      NULLIF(v_line ->> 'rejection_reason', ''),
      v_unit_cost,
      COALESCE((v_line ->> 'tax_rate')::NUMERIC, 0),
      COALESCE((v_line ->> 'discount')::NUMERIC, 0),
      NULLIF(v_line ->> 'batch_number', ''),
      NULLIF(v_line ->> 'expiry_date', '')::DATE,
      NULLIF(v_line ->> 'manufacture_date', '')::DATE,
      NULLIF(v_line ->> 'serial_number', ''),
      NULLIF(v_line ->> 'notes', '')
    ) RETURNING id INTO v_line_id;

    v_subtotal := v_subtotal + (v_quantity * v_unit_cost);
    v_tax := v_tax + ((v_quantity * v_unit_cost) * COALESCE((v_line ->> 'tax_rate')::NUMERIC, 0) / 100);
    v_discount := v_discount + COALESCE((v_line ->> 'discount')::NUMERIC, 0);

    -- Attribute this line to a purchase order line, if given: bump its
    -- received quantity (never past what was ordered) so the order's own
    -- progress reads accurately.
    v_po_line_id := NULLIF(v_line ->> 'purchase_order_line_id', '')::UUID;
    IF v_po_line_id IS NOT NULL THEN
      IF p_purchase_order_id IS NULL THEN
        RAISE EXCEPTION 'A purchase order line was given without a purchase order' USING ERRCODE = '22023';
      END IF;
      SELECT quantity_ordered, quantity_received INTO v_po_line_ordered, v_po_line_received
      FROM purchase_order_lines
      WHERE id = v_po_line_id AND purchase_order_id = p_purchase_order_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Purchase order line not found on this order' USING ERRCODE = 'P0002';
      END IF;
      IF v_po_line_received + v_quantity > v_po_line_ordered THEN
        RAISE EXCEPTION 'Received quantity exceeds the line''s remaining ordered quantity' USING ERRCODE = '22023';
      END IF;
      UPDATE purchase_order_lines
      SET quantity_received = v_po_line_received + v_quantity, updated_at = now()
      WHERE id = v_po_line_id;
    END IF;

    IF v_line ->> 'product_id' IS NOT NULL AND v_quantity > 0 THEN
      INSERT INTO stock_movements (
        store_id, branch_id, product_id, variant_id, quantity_change,
        reason, reference_id, reference_type, supplier_id, unit_cost,
        batch_number, expiry_date, effective_at, notes, created_by
      ) VALUES (
        p_store_id, p_branch_id, v_product.id,
        NULLIF(v_line ->> 'variant_id', '')::UUID, v_quantity,
        'received', v_receipt.id, 'stock_receipt', p_supplier_id, v_unit_cost,
        NULLIF(v_line ->> 'batch_number', ''), NULLIF(v_line ->> 'expiry_date', '')::DATE,
        COALESCE(p_received_at, now()), NULLIF(v_line ->> 'notes', ''), p_received_by
      );

      IF p_branch_id IS NOT NULL THEN
        INSERT INTO branch_inventory_overrides (
          branch_id, product_id, variant_id, stock_quantity
        ) VALUES (
          p_branch_id, v_product.id, NULLIF(v_line ->> 'variant_id', '')::UUID,
          CASE
            WHEN v_line ->> 'variant_id' IS NOT NULL THEN
              (SELECT CASE WHEN stock IS NULL THEN NULL ELSE stock + v_quantity END
               FROM product_variants WHERE id = (v_line ->> 'variant_id')::UUID)
            WHEN v_product.stock IS NULL THEN NULL
            ELSE v_product.stock + v_quantity
          END
        )
        ON CONFLICT (branch_id, product_id, variant_id)
        DO UPDATE SET stock_quantity = CASE
          WHEN branch_inventory_overrides.stock_quantity IS NULL THEN NULL
          ELSE branch_inventory_overrides.stock_quantity + v_quantity
        END;
      ELSIF v_line ->> 'variant_id' IS NOT NULL THEN
        SELECT stock INTO v_variant_stock FROM product_variants
        WHERE id = (v_line ->> 'variant_id')::UUID FOR UPDATE;
        UPDATE product_variants
        SET stock = CASE WHEN v_variant_stock IS NULL THEN NULL ELSE v_variant_stock + v_quantity END
        WHERE id = (v_line ->> 'variant_id')::UUID;
      ELSE
        UPDATE products
        SET cost = CASE
              WHEN stock IS NULL OR stock <= 0 THEN v_unit_cost
              ELSE ROUND(((stock * COALESCE(cost, 0)) + (v_quantity * v_unit_cost)) / (stock + v_quantity), 2)
            END,
            stock = CASE WHEN stock IS NULL THEN NULL ELSE stock + v_quantity END,
            updated_at = now()
        WHERE id = v_product.id;
      END IF;

      UPDATE supplier_products
      SET last_purchase_cost = v_unit_cost,
          last_received_at = COALESCE(p_received_at, now()),
          updated_at = now()
      WHERE store_id = p_store_id
        AND supplier_id = p_supplier_id
        AND product_id = v_product.id
        AND variant_id IS NOT DISTINCT FROM NULLIF(v_line ->> 'variant_id', '')::UUID;
    END IF;
  END LOOP;

  UPDATE stock_receipts
  SET subtotal = v_subtotal,
      tax = v_tax,
      total = GREATEST(v_subtotal + v_tax - v_discount, 0),
      updated_at = now()
  WHERE id = v_receipt.id
  RETURNING * INTO v_receipt;

  -- Roll the order's status up from its lines' totals. Never downgrade a
  -- cancelled order, and never move a status backwards if this receipt
  -- (e.g. all-rejected lines) didn't actually receive anything. When the
  -- order crosses into 'received', stamp received_at (once) — the sent
  -- milestone keeps its own sent_at and is never cleared.
  IF p_purchase_order_id IS NOT NULL THEN
    SELECT COALESCE(SUM(quantity_ordered), 0), COALESCE(SUM(quantity_received), 0)
    INTO v_po_total_ordered, v_po_total_received
    FROM purchase_order_lines
    WHERE purchase_order_id = p_purchase_order_id;

    UPDATE purchase_orders
    SET status = CASE
          WHEN v_po_total_received <= 0 THEN status
          WHEN v_po_total_received >= v_po_total_ordered THEN 'received'
          ELSE 'partially_received'
        END,
        received_at = CASE
          WHEN v_po_total_received >= v_po_total_ordered THEN COALESCE(received_at, now())
          ELSE received_at
        END,
        updated_at = now()
    WHERE id = p_purchase_order_id
      AND status <> 'cancelled';
  END IF;

  RETURN v_receipt;
END;
$$;