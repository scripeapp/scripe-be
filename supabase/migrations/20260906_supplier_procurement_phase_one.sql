-- Supplier procurement phase one: many-to-many sourcing, auditable receipts,
-- inventory provenance, non-sellable tracked items, and honest bill balances.

-- Preserve financial history and give payment reconciliation an explicit state.
ALTER TABLE supplier_payments
  DROP CONSTRAINT IF EXISTS supplier_payments_supplier_id_fkey;

ALTER TABLE supplier_payments
  ADD CONSTRAINT supplier_payments_supplier_id_fkey
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'successful';

ALTER TABLE supplier_payments
  DROP CONSTRAINT IF EXISTS supplier_payments_status_check;

ALTER TABLE supplier_payments
  ADD CONSTRAINT supplier_payments_status_check
  CHECK (status IN ('pending', 'successful', 'failed', 'reversed'));

ALTER TABLE supplier_bills
  ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS approval_state TEXT NOT NULL DEFAULT 'not_required';

UPDATE supplier_bills bills
SET paid_amount = CASE
  WHEN bills.status = 'paid' THEN bills.amount
  ELSE LEAST(bills.amount, COALESCE((
    SELECT SUM(payment.amount)
    FROM supplier_payments payment
    WHERE payment.bill_id = bills.id
      AND payment.status = 'successful'
  ), 0))
END;

ALTER TABLE supplier_bills
  DROP CONSTRAINT IF EXISTS supplier_bills_status_check,
  DROP CONSTRAINT IF EXISTS supplier_bills_paid_amount_check,
  DROP CONSTRAINT IF EXISTS supplier_bills_approval_state_check;

ALTER TABLE supplier_bills
  ADD CONSTRAINT supplier_bills_status_check
    CHECK (status IN ('draft', 'pending', 'approved', 'partially_paid', 'paid', 'overdue', 'disputed', 'cancelled')),
  ADD CONSTRAINT supplier_bills_paid_amount_check CHECK (paid_amount >= 0),
  ADD CONSTRAINT supplier_bills_approval_state_check
    CHECK (approval_state IN ('not_required', 'pending', 'approved', 'rejected'));

UPDATE supplier_bills
SET status = CASE
  WHEN paid_amount >= amount THEN 'paid'
  WHEN paid_amount > 0 THEN 'partially_paid'
  ELSE status
END;

-- A product may be sourced from several suppliers, including variant-specific terms.
CREATE TABLE IF NOT EXISTS supplier_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id UUID REFERENCES product_variants(id) ON DELETE CASCADE,
  supplier_sku TEXT,
  supplier_product_name TEXT,
  unit_cost NUMERIC(14,2) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  minimum_order_quantity INTEGER NOT NULL DEFAULT 1 CHECK (minimum_order_quantity > 0),
  lead_time_days INTEGER CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  is_preferred BOOLEAN NOT NULL DEFAULT false,
  last_purchase_cost NUMERIC(14,2) CHECK (last_purchase_cost IS NULL OR last_purchase_cost >= 0),
  last_received_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_products_unique_grain
    UNIQUE NULLS NOT DISTINCT (store_id, supplier_id, product_id, variant_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS supplier_products_preferred_unique
  ON supplier_products (
    store_id,
    product_id,
    COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE is_preferred = true;

CREATE INDEX IF NOT EXISTS supplier_products_supplier_idx
  ON supplier_products (store_id, supplier_id, status, product_id);
CREATE INDEX IF NOT EXISTS supplier_products_product_idx
  ON supplier_products (store_id, product_id, status);

INSERT INTO supplier_products (store_id, supplier_id, product_id, is_preferred)
SELECT store_id, supplier_id, id, true
FROM products
WHERE supplier_id IS NOT NULL
ON CONFLICT (store_id, supplier_id, product_id, variant_id)
DO NOTHING;

DROP FUNCTION IF EXISTS get_product_catalog_facets(
  UUID, TEXT, TEXT, TEXT[], UUID[], TEXT[], NUMERIC, NUMERIC,
  TIMESTAMPTZ, TIMESTAMPTZ, UUID[], UUID[], TEXT[]
);
DROP INDEX IF EXISTS products_store_supplier_idx;
ALTER TABLE products DROP COLUMN IF EXISTS supplier_id;

-- Non-sellable products remain inventory items but cannot leak into sales channels.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_sellable BOOLEAN NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION enforce_product_sellability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT NEW.is_sellable THEN
    NEW.storefront_enabled := false;
    NEW.pos_enabled := false;
    NEW.marketplace_enabled := false;
    NEW.status := 'draft';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS products_enforce_sellability ON products;
CREATE TRIGGER products_enforce_sellability
BEFORE INSERT OR UPDATE OF is_sellable, storefront_enabled, pos_enabled, marketplace_enabled, status
ON products
FOR EACH ROW EXECUTE FUNCTION enforce_product_sellability();

UPDATE products
SET storefront_enabled = false,
    pos_enabled = false,
    marketplace_enabled = false,
    status = 'draft'
WHERE NOT is_sellable;

-- Receipt documents are the source for received inventory movements.
CREATE TABLE IF NOT EXISTS stock_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  branch_id UUID REFERENCES store_branches(id) ON DELETE RESTRICT,
  purchase_order_id UUID,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed', 'cancelled')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_by UUID REFERENCES users(id) ON DELETE SET NULL,
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  total NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_receipt_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_receipt_id UUID NOT NULL REFERENCES stock_receipts(id) ON DELETE CASCADE,
  purchase_order_line_id UUID,
  product_id UUID REFERENCES products(id) ON DELETE RESTRICT,
  variant_id UUID REFERENCES product_variants(id) ON DELETE RESTRICT,
  description TEXT,
  quantity_received INTEGER NOT NULL CHECK (quantity_received >= 0),
  quantity_rejected INTEGER NOT NULL DEFAULT 0 CHECK (quantity_rejected >= 0),
  rejection_reason TEXT CHECK (rejection_reason IN ('damaged', 'wrong_item', 'short_shipped', 'expired_on_arrival', 'other')),
  unit_cost NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  tax_rate NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0),
  discount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  batch_number TEXT,
  expiry_date DATE,
  manufacture_date DATE,
  serial_number TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The table may have been created by a previous partial run. Add named checks
-- only when they are missing so the migration can be safely resumed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.stock_receipt_lines'::regclass
      AND conname = 'stock_receipt_lines_item_check'
  ) THEN
    ALTER TABLE public.stock_receipt_lines
      ADD CONSTRAINT stock_receipt_lines_item_check
      CHECK (product_id IS NOT NULL OR NULLIF(BTRIM(description), '') IS NOT NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.stock_receipt_lines'::regclass
      AND conname = 'stock_receipt_lines_rejection_reason_check'
  ) THEN
    ALTER TABLE public.stock_receipt_lines
      ADD CONSTRAINT stock_receipt_lines_rejection_reason_check
      CHECK ((quantity_rejected = 0 AND rejection_reason IS NULL) OR (quantity_rejected > 0 AND rejection_reason IS NOT NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.stock_receipt_lines'::regclass
      AND conname = 'stock_receipt_lines_quantity_check'
  ) THEN
    ALTER TABLE public.stock_receipt_lines
      ADD CONSTRAINT stock_receipt_lines_quantity_check
      CHECK (quantity_received > 0 OR quantity_rejected > 0);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS stock_receipts_supplier_idx
  ON stock_receipts (store_id, supplier_id, received_at DESC);
CREATE INDEX IF NOT EXISTS stock_receipts_branch_idx
  ON stock_receipts (branch_id, received_at DESC);
CREATE INDEX IF NOT EXISTS stock_receipt_lines_receipt_idx
  ON stock_receipt_lines (stock_receipt_id);

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(14,2) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  ADD COLUMN IF NOT EXISTS batch_number TEXT,
  ADD COLUMN IF NOT EXISTS expiry_date DATE,
  ADD COLUMN IF NOT EXISTS reference_type TEXT;

CREATE INDEX IF NOT EXISTS stock_movements_supplier_idx
  ON stock_movements (store_id, supplier_id, effective_at DESC);
CREATE INDEX IF NOT EXISTS stock_movements_batch_idx
  ON stock_movements (store_id, product_id, variant_id, branch_id, batch_number)
  WHERE batch_number IS NOT NULL;

ALTER TABLE supplier_bill_items
  ADD COLUMN IF NOT EXISTS stock_receipt_line_id UUID REFERENCES stock_receipt_lines(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS purchase_order_line_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS supplier_bill_items_receipt_line_unique
  ON supplier_bill_items (stock_receipt_line_id)
  WHERE stock_receipt_line_id IS NOT NULL;

-- New procurement data is always isolated through its owning store.
ALTER TABLE supplier_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_receipt_lines ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION validate_supplier_product_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = NEW.supplier_id AND store_id = NEW.store_id) THEN
    RAISE EXCEPTION 'Supplier does not belong to store' USING ERRCODE = '23503';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM products WHERE id = NEW.product_id AND store_id = NEW.store_id) THEN
    RAISE EXCEPTION 'Product does not belong to store' USING ERRCODE = '23503';
  END IF;
  IF NEW.variant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM product_variants WHERE id = NEW.variant_id AND product_id = NEW.product_id
  ) THEN
    RAISE EXCEPTION 'Variant does not belong to product' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS supplier_products_validate_scope ON supplier_products;
CREATE TRIGGER supplier_products_validate_scope
BEFORE INSERT OR UPDATE ON supplier_products
FOR EACH ROW EXECUTE FUNCTION validate_supplier_product_scope();

CREATE OR REPLACE FUNCTION validate_stock_receipt_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = NEW.supplier_id AND store_id = NEW.store_id) THEN
    RAISE EXCEPTION 'Supplier does not belong to receipt store' USING ERRCODE = '23503';
  END IF;
  IF NEW.branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM store_branches WHERE id = NEW.branch_id AND store_id = NEW.store_id
  ) THEN
    RAISE EXCEPTION 'Branch does not belong to receipt store' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stock_receipts_validate_scope ON stock_receipts;
CREATE TRIGGER stock_receipts_validate_scope
BEFORE INSERT OR UPDATE ON stock_receipts
FOR EACH ROW EXECUTE FUNCTION validate_stock_receipt_scope();

CREATE OR REPLACE FUNCTION validate_stock_receipt_line_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_store_id UUID;
BEGIN
  SELECT store_id INTO v_store_id FROM stock_receipts WHERE id = NEW.stock_receipt_id;
  IF NEW.product_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM products WHERE id = NEW.product_id AND store_id = v_store_id
  ) THEN
    RAISE EXCEPTION 'Product does not belong to receipt store' USING ERRCODE = '23503';
  END IF;
  IF NEW.variant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM product_variants WHERE id = NEW.variant_id AND product_id = NEW.product_id
  ) THEN
    RAISE EXCEPTION 'Variant does not belong to receipt product' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stock_receipt_lines_validate_scope ON stock_receipt_lines;
CREATE TRIGGER stock_receipt_lines_validate_scope
BEFORE INSERT OR UPDATE ON stock_receipt_lines
FOR EACH ROW EXECUTE FUNCTION validate_stock_receipt_line_scope();

DROP POLICY IF EXISTS "Supplier products business access" ON supplier_products;
CREATE POLICY "Supplier products business access" ON supplier_products
  FOR ALL USING (
    EXISTS (SELECT 1 FROM stores s WHERE s.id = supplier_products.store_id AND is_business_member(s.business_id))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM stores s WHERE s.id = supplier_products.store_id AND is_business_member(s.business_id))
  );

DROP POLICY IF EXISTS "Stock receipts business access" ON stock_receipts;
CREATE POLICY "Stock receipts business access" ON stock_receipts
  FOR ALL USING (
    EXISTS (SELECT 1 FROM stores s WHERE s.id = stock_receipts.store_id AND is_business_member(s.business_id))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM stores s WHERE s.id = stock_receipts.store_id AND is_business_member(s.business_id))
  );

DROP POLICY IF EXISTS "Stock receipt lines business access" ON stock_receipt_lines;
CREATE POLICY "Stock receipt lines business access" ON stock_receipt_lines
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM stock_receipts receipt
      JOIN stores s ON s.id = receipt.store_id
      WHERE receipt.id = stock_receipt_lines.stock_receipt_id
        AND is_business_member(s.business_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM stock_receipts receipt
      JOIN stores s ON s.id = receipt.store_id
      WHERE receipt.id = stock_receipt_lines.stock_receipt_id
        AND is_business_member(s.business_id)
    )
  );

-- Inserts a payment and reconciles the linked bill in the same transaction.
CREATE OR REPLACE FUNCTION record_supplier_payment(
  p_store_id UUID,
  p_supplier_id UUID,
  p_bill_id UUID,
  p_amount NUMERIC,
  p_payment_date DATE,
  p_method TEXT,
  p_reference TEXT,
  p_notes TEXT,
  p_created_by UUID,
  p_status TEXT DEFAULT 'successful'
)
RETURNS supplier_payments
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_bill supplier_bills%ROWTYPE;
  v_payment supplier_payments%ROWTYPE;
  v_paid_amount NUMERIC;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive' USING ERRCODE = '22023';
  END IF;
  IF p_status NOT IN ('pending', 'successful', 'failed', 'reversed') THEN
    RAISE EXCEPTION 'Invalid supplier payment status' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM suppliers
    WHERE id = p_supplier_id AND store_id = p_store_id
  ) THEN
    RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_bill_id IS NOT NULL THEN
    SELECT * INTO v_bill
    FROM supplier_bills
    WHERE id = p_bill_id
      AND store_id = p_store_id
      AND supplier_id = p_supplier_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Supplier bill not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_bill.status = 'cancelled' THEN
      RAISE EXCEPTION 'Cannot pay a cancelled bill' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO supplier_payments (
    store_id, supplier_id, bill_id, amount, payment_date, method,
    reference, notes, created_by, status
  ) VALUES (
    p_store_id, p_supplier_id, p_bill_id, p_amount,
    COALESCE(p_payment_date, CURRENT_DATE), p_method,
    p_reference, p_notes, p_created_by, p_status
  ) RETURNING * INTO v_payment;

  IF p_bill_id IS NOT NULL AND p_status = 'successful' THEN
    v_paid_amount := v_bill.paid_amount + p_amount;
    UPDATE supplier_bills
    SET paid_amount = v_paid_amount,
        status = CASE WHEN v_paid_amount >= amount THEN 'paid' ELSE 'partially_paid' END,
        updated_at = now()
    WHERE id = p_bill_id;
  END IF;

  RETURN v_payment;
END;
$$;

-- Creates a completed receipt, its lines, movements and balances atomically.
CREATE OR REPLACE FUNCTION create_completed_stock_receipt(
  p_store_id UUID,
  p_supplier_id UUID,
  p_branch_id UUID,
  p_received_at TIMESTAMPTZ,
  p_received_by UUID,
  p_notes TEXT,
  p_lines JSONB
)
RETURNS stock_receipts
LANGUAGE plpgsql
SECURITY INVOKER
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

  INSERT INTO stock_receipts (
    store_id, supplier_id, branch_id, status, received_at, received_by, notes
  ) VALUES (
    p_store_id, p_supplier_id, p_branch_id, 'completed',
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
      stock_receipt_id, product_id, variant_id, description,
      quantity_received, quantity_rejected, rejection_reason, unit_cost,
      tax_rate, discount, batch_number, expiry_date, manufacture_date,
      serial_number, notes
    ) VALUES (
      v_receipt.id,
      NULLIF(v_line ->> 'product_id', '')::UUID,
      NULLIF(v_line ->> 'variant_id', '')::UUID,
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

  RETURN v_receipt;
END;
$$;

-- Supplier filters and facets now read the bridge and omit tracked-only items.
CREATE OR REPLACE FUNCTION get_product_catalog_facets(
  p_store_id UUID,
  p_status TEXT DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_types TEXT[] DEFAULT NULL,
  p_category_ids UUID[] DEFAULT NULL,
  p_availability TEXT[] DEFAULT NULL,
  p_price_min NUMERIC DEFAULT NULL,
  p_price_max NUMERIC DEFAULT NULL,
  p_created_from TIMESTAMPTZ DEFAULT NULL,
  p_created_to TIMESTAMPTZ DEFAULT NULL,
  p_supplier_ids UUID[] DEFAULT NULL,
  p_created_by_ids UUID[] DEFAULT NULL,
  p_channels TEXT[] DEFAULT NULL
)
RETURNS TABLE(facet TEXT, value TEXT, label TEXT, count BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH filtered AS (
    SELECT p.*,
      CASE WHEN p.stock IS NULL OR p.stock = -1 THEN 'unlimited'
           WHEN p.stock <= 0 THEN 'out_of_stock'
           WHEN p.stock <= 10 THEN 'low_stock'
           ELSE 'in_stock' END AS availability_value
    FROM products p
    WHERE p.store_id = p_store_id
      AND p.is_sellable
      AND (p_status IS NULL OR p.status = p_status)
      AND (p_search IS NULL OR p.name ILIKE '%' || p_search || '%')
      AND (p_types IS NULL OR p.type = ANY(p_types))
      AND (p_price_min IS NULL OR p.price >= p_price_min)
      AND (p_price_max IS NULL OR p.price <= p_price_max)
      AND (p_created_from IS NULL OR p.created_at >= p_created_from)
      AND (p_created_to IS NULL OR p.created_at <= p_created_to)
      AND (p_supplier_ids IS NULL OR EXISTS (
        SELECT 1 FROM supplier_products sp
        WHERE sp.product_id = p.id AND sp.status = 'active' AND sp.supplier_id = ANY(p_supplier_ids)
      ))
      AND (p_created_by_ids IS NULL OR p.created_by = ANY(p_created_by_ids))
      AND (p_category_ids IS NULL OR EXISTS (
        SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id = ANY(p_category_ids)
      ))
      AND (p_availability IS NULL OR
        CASE WHEN p.stock IS NULL OR p.stock = -1 THEN 'unlimited'
             WHEN p.stock <= 0 THEN 'out_of_stock'
             WHEN p.stock <= 10 THEN 'low_stock'
             ELSE 'in_stock' END = ANY(p_availability))
      AND (p_channels IS NULL OR
        ('storefront' = ANY(p_channels) AND p.storefront_enabled) OR
        ('pos' = ANY(p_channels) AND p.pos_enabled) OR
        ('marketplace' = ANY(p_channels) AND p.marketplace_enabled))
  ), facet_rows AS (
    SELECT 'types'::TEXT AS facet, type::TEXT AS value, type::TEXT AS label, COUNT(*) AS count FROM filtered GROUP BY type
    UNION ALL
    SELECT 'availability', availability_value, availability_value, COUNT(*) FROM filtered GROUP BY availability_value
    UNION ALL
    SELECT 'categories', c.id::TEXT, c.name, COUNT(*) FROM filtered f JOIN product_categories pc ON pc.product_id = f.id JOIN store_categories c ON c.id = pc.category_id GROUP BY c.id, c.name
    UNION ALL
    SELECT 'suppliers', s.id::TEXT, s.name, COUNT(DISTINCT f.id) FROM filtered f JOIN supplier_products sp ON sp.product_id = f.id AND sp.status = 'active' JOIN suppliers s ON s.id = sp.supplier_id GROUP BY s.id, s.name
    UNION ALL
    SELECT 'creators', u.id::TEXT, COALESCE(u.name, u.username, 'Creator'), COUNT(*) FROM filtered f JOIN users u ON u.id = f.created_by GROUP BY u.id, u.name, u.username
    UNION ALL
    SELECT 'channels', channel, channel, COUNT(*) FROM filtered f CROSS JOIN LATERAL (VALUES ('storefront', f.storefront_enabled), ('pos', f.pos_enabled), ('marketplace', f.marketplace_enabled)) AS ch(channel, enabled) WHERE enabled GROUP BY channel
  )
  SELECT * FROM facet_rows ORDER BY facet, label;
$$;
