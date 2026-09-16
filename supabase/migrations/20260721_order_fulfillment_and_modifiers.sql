-- Food Store checkout plumbing (PRD Phase 4): let an order record which
-- branch fulfils it and how (walk-in pickup vs delivery). Nullable — only
-- meaningful for food stores; general-store orders leave both null.
ALTER TABLE store_orders
ADD COLUMN IF NOT EXISTS fulfillment_type VARCHAR(20)
  CHECK (fulfillment_type IN ('walk_in', 'delivery')),
ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES store_branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_store_orders_branch ON store_orders(branch_id);
