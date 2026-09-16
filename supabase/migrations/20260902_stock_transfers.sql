-- Stock transfers: move stock between a store's branches.
--
-- Conceptually a transfer is "two-sided": sending decrements the source
-- branch (exactly like a checkout decrement via decrement_product_stock),
-- receiving increments the destination branch (like a restock), and the
-- header carries them as one auditable unit. Because the two sides run at
-- different times, a transfer is never written in a single statement — the
-- header + lines are created first (draft), sending commits the decrements
-- (in_transit), and receiving commits the increments (received /
-- partial_received), so the ledger always reflects reality with no double
-- entry.
CREATE TABLE IF NOT EXISTS public.stock_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  reference TEXT NOT NULL,
  from_branch_id UUID NOT NULL
    CONSTRAINT stock_transfers_from_branch_fk
    REFERENCES store_branches(id) ON DELETE RESTRICT,
  to_branch_id UUID NOT NULL
    CONSTRAINT stock_transfers_to_branch_fk
    REFERENCES store_branches(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'in_transit', 'received', 'partial_received', 'cancelled')),
  expected_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  sent_by UUID REFERENCES users(id) ON DELETE SET NULL,
  received_by UUID REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_transfers_no_same_branch CHECK (from_branch_id <> to_branch_id),
  CONSTRAINT stock_transfers_unique_reference UNIQUE (store_id, reference)
);

CREATE INDEX IF NOT EXISTS idx_stock_transfers_store
  ON stock_transfers(store_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_transfers_status
  ON stock_transfers(status);

-- One row per product (optionally a specific variant) being moved. `quantity`
-- is what left the source branch; `received_quantity` tracks how much the
-- destination actually accepted, which lets a transfer settle partially when
-- some items arrive short or were never sent.
CREATE TABLE IF NOT EXISTS public.stock_transfer_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  variant_id UUID REFERENCES product_variants(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  received_quantity INTEGER NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  unit_cost NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_transfer_lines_unique_grain
    UNIQUE (transfer_id, product_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_transfer_lines_transfer
  ON stock_transfer_lines(transfer_id);