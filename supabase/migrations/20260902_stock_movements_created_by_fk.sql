-- Add FK so PostgREST can resolve stock_movements.created_by -> users
-- (enables the `mover:users(name)` embed in getStockMovements list). Nullable,
-- ON DELETE SET NULL preserves the audit trail if a user is removed.

ALTER TABLE public.stock_movements
  ADD CONSTRAINT stock_movements_created_by_fkey
  FOREIGN KEY (created_by)
  REFERENCES public.users(id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_stock_movements_created_by
  ON public.stock_movements(created_by);