-- Purchase orders currently only carry expected_delivery_date (when stock
-- should arrive). Add order_date (when the order was placed) as its own
-- field, distinct from created_at (record-creation timestamp, not
-- merchant-editable) and expected_delivery_date.
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS order_date DATE NOT NULL DEFAULT CURRENT_DATE;
