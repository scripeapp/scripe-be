-- supplier_bill_items: line items for vendor bills
CREATE TABLE IF NOT EXISTS supplier_bill_items (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  bill_id      UUID NOT NULL REFERENCES supplier_bills(id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  quantity     INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price   NUMERIC(12,2) NOT NULL DEFAULT 0,
  total        NUMERIC(12,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_supplier_bill_items_bill_id ON supplier_bill_items(bill_id);

ALTER TABLE supplier_bill_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "suppliers_bill_items_access" ON supplier_bill_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM supplier_bills sb
      JOIN stores s ON s.id = sb.store_id
      WHERE sb.id = supplier_bill_items.bill_id
        AND is_business_member(s.business_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM supplier_bills sb
      JOIN stores s ON s.id = sb.store_id
      WHERE sb.id = supplier_bill_items.bill_id
        AND is_business_member(s.business_id)
    )
  );

-- supplier_payments: payments made to suppliers
CREATE TABLE IF NOT EXISTS supplier_payments (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id     UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  supplier_id  UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  bill_id      UUID REFERENCES supplier_bills(id) ON DELETE SET NULL,
  amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  method       TEXT NOT NULL DEFAULT 'bank_transfer',
  reference    TEXT,
  notes        TEXT,
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_supplier_payments_store_supplier ON supplier_payments(store_id, supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_bill_id ON supplier_payments(bill_id);

ALTER TABLE supplier_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "suppliers_payments_access" ON supplier_payments
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM stores s
      WHERE s.id = supplier_payments.store_id
        AND is_business_member(s.business_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM stores s
      WHERE s.id = supplier_payments.store_id
        AND is_business_member(s.business_id)
    )
  );
