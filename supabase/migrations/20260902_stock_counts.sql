-- Stock counts (cycle counts): compare what the system thinks a branch has
-- against what is actually on the shelf, then on Apply write the difference
-- as real adjustments.
--
-- A count is deliberately inert while in progress: its lines only record the
-- system-expected quantity, the counted quantity, and the implied variance.
-- Nothing touches live stock until the merchant applies the count, at which
-- point each line's variance posts as a count-reason movement on the branch,
-- exactly like a transfer receive — so a half-finished or discarded count can
-- never move stock.
CREATE TABLE IF NOT EXISTS public.stock_counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL
    CONSTRAINT stock_counts_branch_fk
    REFERENCES store_branches(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'applied', 'cancelled')),
  reference TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all'
    CHECK (scope IN ('all', 'selected')),
  count_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  counted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_counts_unique_reference UNIQUE (store_id, reference)
);

CREATE INDEX IF NOT EXISTS idx_stock_counts_store
  ON stock_counts(store_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_counts_status
  ON stock_counts(status);

-- One row per product (optionally a specific variant). `system_quantity` is
-- the branch's expected on-hand at count time; `counted_quantity` is what the
-- counter entered; variance = counted - system. `unit_cost` lets the UI show
-- the value impact of a variance without a per-row cost lookup.
CREATE TABLE IF NOT EXISTS public.stock_count_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  count_id UUID NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  variant_id UUID REFERENCES product_variants(id) ON DELETE RESTRICT,
  system_quantity INTEGER NOT NULL,
  counted_quantity INTEGER NOT NULL CHECK (counted_quantity >= 0),
  unit_cost NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_count_lines_unique_grain
    UNIQUE (count_id, product_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_count_lines_count
  ON stock_count_lines(count_id);