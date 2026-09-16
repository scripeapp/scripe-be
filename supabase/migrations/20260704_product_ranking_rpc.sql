-- RPC called nightly by the scheduler to recalculate product ranking scores.
--
-- trending_score = (units sold last 7d × 3) + (units sold last 30d × 1.5) + (lifetime orders_count × 0.2)
-- revenue_score  = total revenue (quantity × price) from store_orders in last 30d, per product

CREATE OR REPLACE FUNCTION recalculate_product_trending_scores()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Compute per-product order volume from last 7d and 30d using the JSONB items array.
  -- Each element has at minimum: { "product_id": "...", "quantity": N, "price": N }
  WITH recent_orders AS (
    SELECT
      item->>'product_id'                          AS product_id,
      (item->>'quantity')::numeric                 AS quantity,
      (item->>'price')::numeric                    AS price,
      created_at
    FROM store_orders,
         jsonb_array_elements(items) AS item
    WHERE status NOT IN ('cancelled', 'refunded')
      AND created_at >= NOW() - INTERVAL '30 days'
  ),
  scores AS (
    SELECT
      product_id,
      SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days'  THEN quantity ELSE 0 END) AS units_7d,
      SUM(quantity)                                                                     AS units_30d,
      SUM(quantity * price)                                                             AS revenue_30d
    FROM recent_orders
    GROUP BY product_id
  )
  UPDATE products p
  SET
    trending_score = ROUND(
      (COALESCE(s.units_7d, 0)  * 3)
      + (COALESCE(s.units_30d, 0) * 1.5)
      + (COALESCE(p.orders_count, 0) * 0.2),
      4
    ),
    revenue_score = ROUND(COALESCE(s.revenue_30d, 0), 4)
  FROM scores s
  WHERE p.id::text = s.product_id
    AND p.status = 'active';

  -- Zero out scores for products that had no orders in the last 30d
  -- (they keep their lifetime orders_count contribution only)
  UPDATE products
  SET
    trending_score = ROUND(COALESCE(orders_count, 0) * 0.2, 4),
    revenue_score  = 0
  WHERE status = 'active'
    AND id NOT IN (
      SELECT DISTINCT (item->>'product_id')::uuid
      FROM store_orders,
           jsonb_array_elements(items) AS item
      WHERE status NOT IN ('cancelled', 'refunded')
        AND created_at >= NOW() - INTERVAL '30 days'
    );
END;
$$;
