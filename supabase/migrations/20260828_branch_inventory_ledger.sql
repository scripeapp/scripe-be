-- Extend the immutable inventory ledger with branch attribution. Current
-- balances are introduced separately in branch_inventory_overrides by the
-- following migration; product_branch_overrides remains catalog-only.
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS branch_id UUID
  REFERENCES store_branches(id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_stock_movements_branch
  ON stock_movements(branch_id);
