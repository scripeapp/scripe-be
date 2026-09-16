-- Backfill orders_count from existing store_orders
-- This updates products.orders_count based on historical order data

WITH order_totals AS (
  SELECT 
    (item->>'product_id')::uuid AS product_id,
    SUM(COALESCE((item->>'quantity')::int, 1)) AS total_sold
  FROM store_orders,
  LATERAL jsonb_array_elements(items) AS item
  WHERE status IN ('paid', 'fulfilled')
  GROUP BY (item->>'product_id')::uuid
)
UPDATE products p
SET orders_count = COALESCE(ot.total_sold, 0)
FROM order_totals ot
WHERE p.id = ot.product_id;

-- Also ensure orders_count defaults to 0 for any products that weren't updated
UPDATE products SET orders_count = 0 WHERE orders_count IS NULL;
