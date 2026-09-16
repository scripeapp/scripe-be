-- Stock Movements Table
-- Tracks all inventory changes with audit trail

CREATE TABLE stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id UUID REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity_change INTEGER NOT NULL, -- positive for add, negative for subtract
  reason TEXT CHECK (reason IN ('sale', 'restock', 'adjustment', 'return')) NOT NULL,
  reference_id UUID, -- order_id if reason is 'sale' or 'return'
  notes TEXT,
  created_by UUID, -- user who made the change
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_stock_movements_product ON stock_movements(product_id);
CREATE INDEX idx_stock_movements_variant ON stock_movements(variant_id);
CREATE INDEX idx_stock_movements_date ON stock_movements(created_at DESC);
CREATE INDEX idx_stock_movements_reason ON stock_movements(reason);

-- RLS Policies
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;

-- Store owners/members can view stock movements for their products
CREATE POLICY "Business members can view stock movements"
  ON stock_movements
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM products p
      JOIN stores s ON s.id = p.store_id
      JOIN memberships m ON m.business_id = s.business_id
      WHERE p.id = stock_movements.product_id
        AND m.user_id = auth.uid()
    )
  );

-- Store owners/members can insert stock movements
CREATE POLICY "Business members can insert stock movements"
  ON stock_movements
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM products p
      JOIN stores s ON s.id = p.store_id
      JOIN memberships m ON m.business_id = s.business_id
      WHERE p.id = stock_movements.product_id
        AND m.user_id = auth.uid()
    )
  );

COMMENT ON TABLE stock_movements IS 'Audit trail for all inventory changes';
COMMENT ON COLUMN stock_movements.quantity_change IS 'Positive for additions, negative for subtractions';
COMMENT ON COLUMN stock_movements.reason IS 'sale=sold, restock=added inventory, adjustment=manual change, return=customer return';
