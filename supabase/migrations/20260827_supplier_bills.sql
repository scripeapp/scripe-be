CREATE TABLE IF NOT EXISTS supplier_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  bill_number TEXT NOT NULL,
  invoice_number TEXT,
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'NGN',
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('paid','pending','overdue')),
  items_count INTEGER NOT NULL DEFAULT 0 CHECK (items_count >= 0),
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, bill_number)
);

CREATE INDEX IF NOT EXISTS supplier_bills_supplier_idx ON supplier_bills (store_id, supplier_id, issue_date DESC);
ALTER TABLE supplier_bills ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Business members can manage supplier bills" ON supplier_bills;

CREATE POLICY "Business members can manage supplier bills" ON supplier_bills
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM stores
      JOIN memberships ON memberships.business_id = stores.business_id
      WHERE stores.id = supplier_bills.store_id
        AND memberships.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM stores
      JOIN memberships ON memberships.business_id = stores.business_id
      WHERE stores.id = supplier_bills.store_id
        AND memberships.user_id = auth.uid()
    )
  );
