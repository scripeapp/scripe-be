-- Registers/POS Phase B: the till-shift entity. One implicit register per
-- branch for now (not a separate `registers` table yet — see
-- registers-prd-mvp.md Phase 2/4) — a branch can have at most one OPEN
-- shift at a time, enforced by the partial unique index below.

CREATE TABLE IF NOT EXISTS register_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES store_branches(id) ON DELETE CASCADE,
  opened_by UUID REFERENCES auth.users(id),
  closed_by UUID REFERENCES auth.users(id),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  starting_float INTEGER NOT NULL DEFAULT 0,
  counted_cash INTEGER,
  expected_cash INTEGER,
  variance INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_register_shifts_branch ON register_shifts(branch_id);
CREATE INDEX IF NOT EXISTS idx_register_shifts_status ON register_shifts(status);

-- At most one OPEN shift per branch at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_register_shifts_one_open_per_branch
  ON register_shifts(branch_id)
  WHERE status = 'open';

-- Deferred from 20260727_store_orders_pos_columns.sql — register_shifts
-- didn't exist yet when that column was added.
ALTER TABLE store_orders
ADD CONSTRAINT store_orders_register_shift_id_fkey
  FOREIGN KEY (register_shift_id) REFERENCES register_shifts(id);

-- RLS Policies — mirrors stock_movements' business-membership-scoped
-- pattern (the closest precedent: an operational ledger, not a public
-- catalog table).
ALTER TABLE register_shifts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Business members can view register shifts"
  ON register_shifts
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM store_branches b
      JOIN stores s ON s.id = b.store_id
      JOIN memberships m ON m.business_id = s.business_id
      WHERE b.id = register_shifts.branch_id
        AND m.user_id = auth.uid()
    )
  );

CREATE POLICY "Business members can open register shifts"
  ON register_shifts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM store_branches b
      JOIN stores s ON s.id = b.store_id
      JOIN memberships m ON m.business_id = s.business_id
      WHERE b.id = register_shifts.branch_id
        AND m.user_id = auth.uid()
    )
  );

CREATE POLICY "Business members can close register shifts"
  ON register_shifts
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM store_branches b
      JOIN stores s ON s.id = b.store_id
      JOIN memberships m ON m.business_id = s.business_id
      WHERE b.id = register_shifts.branch_id
        AND m.user_id = auth.uid()
    )
  );

COMMENT ON TABLE register_shifts IS 'A cashier''s till session at a branch — opened with a starting cash float, closed with a counted-cash reconciliation against expected sales.';
