-- POS/register groundwork on store_orders: how an order was paid, who
-- rang it up, and (once register_shifts exists) which till session it
-- belongs to. payment_method mirrors the existing
-- issued_tickets.payment_method precedent (online/cash).
-- register_shift_id has no FK yet — register_shifts is created in a later
-- migration; the FK is added there once the target table exists.

ALTER TABLE store_orders
ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'online',
ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id),
ADD COLUMN IF NOT EXISTS register_shift_id UUID;

COMMENT ON COLUMN store_orders.payment_method IS 'Payment method used: online | cash | card | transfer. Used for auditing/register reconciliation.';
