-- Products V2: metadata and fixed sales-channel controls.
-- The three channel flags intentionally live on products: V2 only needs
-- enablement, so a relation table would add joins without representing data.

CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  contact_person TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  address TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  website TEXT,
  payment_terms TEXT NOT NULL DEFAULT 'Net 30',
  bank_name TEXT,
  account_number TEXT,
  account_name TEXT,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, name),
  UNIQUE (store_id, code)
);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS storefront_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS pos_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS marketplace_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS digital_link_expiry_hours INTEGER;

UPDATE products
SET created_by = stores.user_id
FROM stores
WHERE products.store_id = stores.id
  AND products.created_by IS NULL
  AND stores.user_id IS NOT NULL;

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_digital_link_expiry_hours_check;

ALTER TABLE products
  ADD CONSTRAINT products_digital_link_expiry_hours_check
  CHECK (
    digital_link_expiry_hours IS NULL
    OR digital_link_expiry_hours BETWEEN 1 AND 8760
  );

CREATE TABLE IF NOT EXISTS product_bookable_staff (
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  staff_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  availability_profile_id UUID REFERENCES availability_profiles(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, staff_user_id)
);

ALTER TABLE service_bookings
  ADD COLUMN IF NOT EXISTS staff_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS products_store_creator_idx
  ON products (store_id, created_by);
CREATE INDEX IF NOT EXISTS products_store_supplier_idx
  ON products (store_id, supplier_id);
CREATE INDEX IF NOT EXISTS products_storefront_enabled_idx
  ON products (store_id, created_at DESC) WHERE storefront_enabled AND status = 'published';
CREATE INDEX IF NOT EXISTS products_pos_enabled_idx
  ON products (store_id, created_at DESC) WHERE pos_enabled AND status = 'published';
CREATE INDEX IF NOT EXISTS products_marketplace_enabled_idx
  ON products (store_id, created_at DESC) WHERE marketplace_enabled AND status = 'published';
CREATE INDEX IF NOT EXISTS product_bookable_staff_product_idx
  ON product_bookable_staff (product_id, is_active, position);
CREATE INDEX IF NOT EXISTS service_bookings_product_status_idx
  ON service_bookings (product_id, status, created_at DESC);

CREATE OR REPLACE FUNCTION get_product_dashboard_metrics(
  p_store_id UUID,
  p_product_id UUID
)
RETURNS TABLE (
  units_sold BIGINT,
  revenue NUMERIC,
  customer_count BIGINT,
  refunded_order_count BIGINT,
  pre_order_count BIGINT,
  last_sale_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
  WITH product_order_items AS (
    SELECT
      orders.id,
      orders.status,
      orders.created_at,
      orders.customer_email,
      item.value AS item
    FROM store_orders AS orders
    CROSS JOIN LATERAL jsonb_array_elements(orders.items) AS item(value)
    WHERE orders.store_id = p_store_id
      AND item.value ->> 'product_id' = p_product_id::text
  )
  SELECT
    COALESCE(SUM(CASE WHEN status IN ('paid', 'processing', 'fulfilled')
      THEN COALESCE((item ->> 'quantity')::BIGINT, 0) ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN status IN ('paid', 'processing', 'fulfilled')
      THEN COALESCE((item ->> 'price')::NUMERIC, 0) * COALESCE((item ->> 'quantity')::NUMERIC, 0) ELSE 0 END), 0),
    COUNT(DISTINCT customer_email) FILTER (WHERE status IN ('paid', 'processing', 'fulfilled')),
    COUNT(DISTINCT id) FILTER (WHERE status = 'refunded'),
    COUNT(DISTINCT id) FILTER (WHERE status = 'pre_order'),
    MAX(created_at) FILTER (WHERE status IN ('paid', 'processing', 'fulfilled'))
  FROM product_order_items;
$$;

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_bookable_staff ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Business members can read suppliers" ON suppliers
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM stores
      JOIN memberships ON memberships.business_id = stores.business_id
      WHERE stores.id = suppliers.store_id
        AND memberships.user_id = auth.uid()
    )
  );

CREATE POLICY "Business members can manage suppliers" ON suppliers
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM stores
      JOIN memberships ON memberships.business_id = stores.business_id
      WHERE stores.id = suppliers.store_id
        AND memberships.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM stores
      JOIN memberships ON memberships.business_id = stores.business_id
      WHERE stores.id = suppliers.store_id
        AND memberships.user_id = auth.uid()
    )
  );

CREATE POLICY "Business members can read product staff" ON product_bookable_staff
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM products
      JOIN stores ON stores.id = products.store_id
      JOIN memberships ON memberships.business_id = stores.business_id
      WHERE products.id = product_bookable_staff.product_id
        AND memberships.user_id = auth.uid()
    )
  );

CREATE POLICY "Business members can manage product staff" ON product_bookable_staff
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM products
      JOIN stores ON stores.id = products.store_id
      JOIN memberships ON memberships.business_id = stores.business_id
      WHERE products.id = product_bookable_staff.product_id
        AND memberships.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM products
      JOIN stores ON stores.id = products.store_id
      JOIN memberships ON memberships.business_id = stores.business_id
      WHERE products.id = product_bookable_staff.product_id
        AND memberships.user_id = auth.uid()
    )
  );
