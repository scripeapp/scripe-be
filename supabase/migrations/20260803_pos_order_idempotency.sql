-- POS devices sit on shop wifi; a network drop between the server
-- committing a sale and the client receiving the response is a real,
-- expected failure mode (not an edge case). Without a dedup key, a
-- cashier retrying "Complete sale" after a "Failed to fetch" could
-- double-charge and double-decrement stock. This key lets createPosOrder
-- treat a retried submission as a no-op replay of the original order.
ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_store_orders_idempotency_key
  ON store_orders (store_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

NOTIFY pgrst, 'reload schema';
