-- Persist the discount evidence needed for merchant reporting and bookkeeping.
-- All columns are nullable/defaulted so existing production orders remain valid.

BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS subtotal_amount numeric(12, 2),
  ADD COLUMN IF NOT EXISTS discount_amount numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS surcharge_amount numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency varchar(3) NOT NULL DEFAULT 'NGN',
  ADD COLUMN IF NOT EXISTS discount_code text,
  ADD COLUMN IF NOT EXISTS discount_details jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE store_orders
  ADD COLUMN IF NOT EXISTS discount_code text,
  ADD COLUMN IF NOT EXISTS discount_details jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN orders.subtotal_amount IS
  'Buyer-currency ticket subtotal before discounts and surcharges.';
COMMENT ON COLUMN orders.discount_amount IS
  'Buyer-currency discount deducted from this event order.';
COMMENT ON COLUMN orders.surcharge_amount IS
  'Buyer-currency pricing-rule surcharge added to this event order.';
COMMENT ON COLUMN orders.discount_details IS
  'Immutable JSON snapshot of event discount rules applied at checkout.';
COMMENT ON COLUMN store_orders.discount_code IS
  'Discount code successfully applied to this store order.';
COMMENT ON COLUMN store_orders.discount_details IS
  'Immutable JSON snapshot of the store discount applied at checkout.';

-- Recover the accounting snapshot for historical event orders where the
-- provider-neutral pending checkout is still available.
UPDATE orders AS order_row
SET
  subtotal_amount = CASE
    WHEN pending.metadata #>> '{event_payment_summary,subtotal}' ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN (pending.metadata #>> '{event_payment_summary,subtotal}')::numeric
    ELSE order_row.total_amount
  END,
  discount_amount = CASE
    WHEN pending.metadata #>> '{event_payment_summary,discount}' ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN (pending.metadata #>> '{event_payment_summary,discount}')::numeric
    ELSE 0
  END,
  surcharge_amount = CASE
    WHEN pending.metadata #>> '{event_payment_summary,surcharge}' ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN (pending.metadata #>> '{event_payment_summary,surcharge}')::numeric
    ELSE 0
  END,
  currency = LEFT(UPPER(COALESCE(
    pending.metadata #>> '{event_payment_summary,currency}',
    pending.metadata ->> 'currency',
    'NGN'
  )), 3),
  discount_code = NULLIF(
    pending.metadata #>> '{event_payment_summary,coupon_code}',
    ''
  ),
  discount_details = CASE
    WHEN jsonb_typeof(pending.metadata #> '{event_payment_summary,discounts}') = 'array'
      THEN pending.metadata #> '{event_payment_summary,discounts}'
    ELSE '[]'::jsonb
  END
FROM pending_checkouts AS pending
WHERE order_row.payment_reference = pending.reference
  AND jsonb_typeof(pending.metadata -> 'event_payment_summary') = 'object';

-- Store orders already contain the accounting amount; backfill the submitted
-- code and an audit snapshot for older provider checkouts.
UPDATE store_orders AS order_row
SET
  discount_code = NULLIF(pending.metadata ->> 'discount_code', ''),
  discount_details = CASE
    WHEN order_row.discount > 0
      AND NULLIF(pending.metadata ->> 'discount_code', '') IS NOT NULL
      THEN jsonb_build_array(jsonb_build_object(
        'code', pending.metadata ->> 'discount_code',
        'amount', order_row.discount
      ))
    ELSE '[]'::jsonb
  END
FROM pending_checkouts AS pending
WHERE order_row.payment_reference = pending.reference
  AND NULLIF(pending.metadata ->> 'discount_code', '') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_discount_code
  ON orders(discount_code)
  WHERE discount_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_store_orders_discount_code
  ON store_orders(discount_code)
  WHERE discount_code IS NOT NULL;

COMMIT;
