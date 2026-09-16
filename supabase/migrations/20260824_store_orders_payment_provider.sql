-- Record which gateway processed each store order.
--
-- The UI and reporting previously inferred this from the payment_reference
-- prefix (FLW-/CASH-/MANUAL-). Provider identity belongs to the data, not
-- re-derived at render time from a naming convention.
ALTER TABLE store_orders
  ADD COLUMN IF NOT EXISTS payment_provider VARCHAR(20);

COMMENT ON COLUMN store_orders.payment_provider IS
  'Gateway that processed the charge: paystack | flutterwave | cash';
