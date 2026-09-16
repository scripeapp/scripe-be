-- Track whether confirmation emails were dispatched for an order.
-- NULL means the email flow never completed (webhook failed mid-send,
-- Plunk was down, etc.). Used by the Payment Recovery admin page to
-- surface orders that need a manual email resend.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS confirmation_email_sent_at TIMESTAMPTZ;

ALTER TABLE store_orders
  ADD COLUMN IF NOT EXISTS confirmation_email_sent_at TIMESTAMPTZ;

-- Drop the set_updated_at trigger on `orders` before backfilling — the trigger
-- references NEW.updated_at which doesn't exist on this table, so any UPDATE
-- (including the backfill below) fails. The trigger was mistakenly applied.
DROP TRIGGER IF EXISTS orders_set_updated_at ON orders;

-- Backfill all pre-existing rows: assume emails were sent at order creation
-- time since these orders predate this tracking column. Only new orders
-- created after this migration will have a meaningful NULL (= email not sent).
UPDATE orders
  SET confirmation_email_sent_at = created_at
  WHERE confirmation_email_sent_at IS NULL;

UPDATE store_orders
  SET confirmation_email_sent_at = created_at
  WHERE confirmation_email_sent_at IS NULL;
