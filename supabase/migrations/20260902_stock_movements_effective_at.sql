-- Add an effective/took-effect timestamp to stock movements.
--
-- A movement's `created_at` records when it was submitted (an audit fact that
-- must never change). `effective_at` records when the stock change is *meant*
-- to have taken effect, which merchants backdate when they log something late
-- (e.g. "I actually received these five days ago"). Keeping the two separate
-- makes the ledger honest: the audit trail is immutable, while the business
-- date is user-controllable.
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_stock_movements_effective_at
  ON stock_movements(effective_at DESC);

COMMENT ON COLUMN stock_movements.effective_at
  IS 'The date the stock change is meant to have taken effect (backdatable); created_at is the immutable audit timestamp.';