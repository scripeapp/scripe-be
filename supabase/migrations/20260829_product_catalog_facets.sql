CREATE OR REPLACE FUNCTION get_product_catalog_facets(
  p_store_id UUID,
  p_status TEXT DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_types TEXT[] DEFAULT NULL,
  p_category_ids UUID[] DEFAULT NULL,
  p_availability TEXT[] DEFAULT NULL,
  p_price_min NUMERIC DEFAULT NULL,
  p_price_max NUMERIC DEFAULT NULL,
  p_created_from TIMESTAMPTZ DEFAULT NULL,
  p_created_to TIMESTAMPTZ DEFAULT NULL,
  p_supplier_ids UUID[] DEFAULT NULL,
  p_created_by_ids UUID[] DEFAULT NULL,
  p_channels TEXT[] DEFAULT NULL
)
RETURNS TABLE(facet TEXT, value TEXT, label TEXT, count BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH filtered AS (
    SELECT p.*,
      CASE WHEN p.stock IS NULL OR p.stock = -1 THEN 'unlimited'
           WHEN p.stock <= 0 THEN 'out_of_stock'
           WHEN p.stock <= 10 THEN 'low_stock'
           ELSE 'in_stock' END AS availability_value
    FROM products p
    WHERE p.store_id = p_store_id
      AND (p_status IS NULL OR p.status = p_status)
      AND (p_search IS NULL OR p.name ILIKE '%' || p_search || '%')
      AND (p_types IS NULL OR p.type = ANY(p_types))
      AND (p_price_min IS NULL OR p.price >= p_price_min)
      AND (p_price_max IS NULL OR p.price <= p_price_max)
      AND (p_created_from IS NULL OR p.created_at >= p_created_from)
      AND (p_created_to IS NULL OR p.created_at <= p_created_to)
      AND (p_supplier_ids IS NULL OR p.supplier_id = ANY(p_supplier_ids))
      AND (p_created_by_ids IS NULL OR p.created_by = ANY(p_created_by_ids))
      AND (p_category_ids IS NULL OR EXISTS (
        SELECT 1 FROM product_categories pc
        WHERE pc.product_id = p.id AND pc.category_id = ANY(p_category_ids)
      ))
      AND (p_availability IS NULL OR
        CASE WHEN p.stock IS NULL OR p.stock = -1 THEN 'unlimited'
             WHEN p.stock <= 0 THEN 'out_of_stock'
             WHEN p.stock <= 10 THEN 'low_stock'
             ELSE 'in_stock' END = ANY(p_availability))
      AND (p_channels IS NULL OR
        ('storefront' = ANY(p_channels) AND p.storefront_enabled) OR
        ('pos' = ANY(p_channels) AND p.pos_enabled) OR
        ('marketplace' = ANY(p_channels) AND p.marketplace_enabled))
  ), facet_rows AS (
    SELECT 'types'::TEXT facet, type::TEXT value, type::TEXT label, COUNT(*) count FROM filtered GROUP BY type
    UNION ALL
    SELECT 'availability', availability_value, availability_value, COUNT(*) FROM filtered GROUP BY availability_value
    UNION ALL
    SELECT 'categories', c.id::TEXT, c.name, COUNT(*) FROM filtered f
      JOIN product_categories pc ON pc.product_id = f.id
      JOIN store_categories c ON c.id = pc.category_id GROUP BY c.id, c.name
    UNION ALL
    SELECT 'suppliers', s.id::TEXT, s.name, COUNT(*) FROM filtered f
      JOIN suppliers s ON s.id = f.supplier_id GROUP BY s.id, s.name
    UNION ALL
    SELECT 'creators', u.id::TEXT, COALESCE(u.name, u.username, 'Creator'), COUNT(*) FROM filtered f
      JOIN users u ON u.id = f.created_by GROUP BY u.id, u.name, u.username
    UNION ALL
    SELECT 'channels', channel, channel, COUNT(*) FROM filtered f
      CROSS JOIN LATERAL (VALUES
        ('storefront', f.storefront_enabled), ('pos', f.pos_enabled), ('marketplace', f.marketplace_enabled)
      ) AS ch(channel, enabled) WHERE enabled GROUP BY channel
  )
  SELECT facet, value, label, count FROM facet_rows ORDER BY facet, label;
$$;
