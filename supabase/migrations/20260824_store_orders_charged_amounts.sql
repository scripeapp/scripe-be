-- Charge-truth columns for multi-currency store orders.
--
-- store_orders.total/currency stay NGN-normalized for analytics and
-- bookkeeping (see completeStoreCheckout). These columns carry what the
-- buyer's charge was actually worth after Flutterwave took its fee — gross
-- minus gateway fee — so foreign-currency orders reflect real value received,
-- not an inflated pre-fee figure.
ALTER TABLE store_orders
  ADD COLUMN IF NOT EXISTS charged_currency VARCHAR(3),
  ADD COLUMN IF NOT EXISTS charged_net_total DECIMAL(10, 2);

COMMENT ON COLUMN store_orders.charged_currency IS
  'Currency the buyer was charged in; NULL for NGN orders (same as currency)';
COMMENT ON COLUMN store_orders.charged_net_total IS
  'Buyer charge minus gateway fee, in charged_currency; NULL when unknown';
