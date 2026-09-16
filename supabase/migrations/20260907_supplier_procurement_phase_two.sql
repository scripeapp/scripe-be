-- Purchase-to-pay phase two: purchase orders, line-level receiving links,
-- transfer traceability, and an on-hand batch balance read model.

CREATE TABLE IF NOT EXISTS purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  branch_id UUID REFERENCES store_branches(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','partially_received','received','cancelled')),
  order_number TEXT NOT NULL,
  expected_delivery_date DATE,
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  total NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, order_number)
);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE RESTRICT,
  variant_id UUID REFERENCES product_variants(id) ON DELETE RESTRICT,
  description TEXT,
  quantity_ordered INTEGER NOT NULL CHECK (quantity_ordered > 0),
  quantity_received INTEGER NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  unit_cost NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  tax_rate NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0),
  discount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT purchase_order_lines_item_check CHECK (product_id IS NOT NULL OR NULLIF(BTRIM(description), '') IS NOT NULL),
  CONSTRAINT purchase_order_lines_variant_check CHECK (variant_id IS NULL OR product_id IS NOT NULL),
  CONSTRAINT purchase_order_lines_received_check CHECK (quantity_received <= quantity_ordered)
);

ALTER TABLE stock_receipts
  ADD CONSTRAINT stock_receipts_purchase_order_fk
  FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE SET NULL;
ALTER TABLE stock_receipt_lines
  ADD CONSTRAINT stock_receipt_lines_purchase_order_line_fk
  FOREIGN KEY (purchase_order_line_id) REFERENCES purchase_order_lines(id) ON DELETE SET NULL;
ALTER TABLE supplier_bill_items
  ADD CONSTRAINT supplier_bill_items_purchase_order_line_fk
  FOREIGN KEY (purchase_order_line_id) REFERENCES purchase_order_lines(id) ON DELETE SET NULL;

ALTER TABLE stock_transfer_lines
  ADD COLUMN IF NOT EXISTS batch_number TEXT,
  ADD COLUMN IF NOT EXISTS expiry_date DATE;

CREATE INDEX IF NOT EXISTS purchase_orders_store_status_idx ON purchase_orders (store_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS purchase_orders_supplier_idx ON purchase_orders (store_id, supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS purchase_order_lines_order_idx ON purchase_order_lines (purchase_order_id);

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY purchase_orders_business_access ON purchase_orders
  USING (EXISTS (SELECT 1 FROM stores s WHERE s.id = purchase_orders.store_id AND is_business_member(s.business_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM stores s WHERE s.id = purchase_orders.store_id AND is_business_member(s.business_id)));
CREATE POLICY purchase_order_lines_business_access ON purchase_order_lines
  USING (EXISTS (SELECT 1 FROM purchase_orders po JOIN stores s ON s.id = po.store_id WHERE po.id = purchase_order_lines.purchase_order_id AND is_business_member(s.business_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM purchase_orders po JOIN stores s ON s.id = po.store_id WHERE po.id = purchase_order_lines.purchase_order_id AND is_business_member(s.business_id)));

CREATE OR REPLACE VIEW stock_batch_balances AS
SELECT
  sm.store_id,
  sm.product_id,
  sm.variant_id,
  sm.branch_id,
  sm.batch_number,
  sm.expiry_date,
  SUM(sm.quantity_change)::INTEGER AS quantity_on_hand,
  MAX(sm.unit_cost) AS unit_cost,
  MAX(sm.effective_at) AS last_movement_at
FROM stock_movements sm
WHERE sm.batch_number IS NOT NULL
GROUP BY sm.store_id, sm.product_id, sm.variant_id, sm.branch_id, sm.batch_number, sm.expiry_date
HAVING SUM(sm.quantity_change) <> 0;
