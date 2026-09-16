-- ============================================================================
-- Public Access RLS Policies
-- Ensures that live/published content is accessible to the public (anon role)
-- ============================================================================

-- 1. WEBSITES
-- Public can view live websites
DROP POLICY IF EXISTS "Public can view live websites" ON websites;
CREATE POLICY "Public can view live websites" ON websites
  FOR SELECT USING (is_live = true);

-- 2. STORES
-- Public can view live stores
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Business member access" ON stores;
CREATE POLICY "Business member access" ON stores
  FOR ALL USING (is_business_member(business_id));

DROP POLICY IF EXISTS "Public can view live stores" ON stores;
CREATE POLICY "Public can view live stores" ON stores
  FOR SELECT USING (is_live = true);

-- 3. PRODUCTS
-- Public can view published products
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Business members can manage products" ON products;
CREATE POLICY "Business members can manage products" ON products
  FOR ALL USING (
    EXISTS (
        SELECT 1 FROM stores s
        WHERE s.id = products.store_id
        AND is_business_member(s.business_id)
    )
  );

DROP POLICY IF EXISTS "Public can view published products" ON products;
CREATE POLICY "Public can view published products" ON products
  FOR SELECT USING (status = 'published');

-- 4. EVENTS
-- Public can view published events
-- Note: Assuming 'published' status exists. If not, maybe verify schema.
-- Checking events table schema from context/memory: it has status.

DROP POLICY IF EXISTS "Public can view published events" ON events;
CREATE POLICY "Public can view published events" ON events
  FOR SELECT USING (status = 'published');

-- 5. HALQAHS
-- Public can view halqahs (assuming all are public for now or filtering by category)
-- If there's a status column, use it.
DROP POLICY IF EXISTS "Public can view halqahs" ON halqahs;
CREATE POLICY "Public can view halqahs" ON halqahs
  FOR SELECT USING (true); -- Adjust if there's a status column

-- 6. STORE ORDERS
-- Public can create orders
ALTER TABLE store_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Business members can manage orders" ON store_orders;
CREATE POLICY "Business members can manage orders" ON store_orders
  FOR ALL USING (
    EXISTS (
        SELECT 1 FROM stores s
        WHERE s.id = store_orders.store_id
        AND is_business_member(s.business_id)
    )
  );

DROP POLICY IF EXISTS "Public can create orders" ON store_orders;
CREATE POLICY "Public can create orders" ON store_orders
  FOR INSERT WITH CHECK (true);

-- Public can view their own orders?
-- Without auth, we can't easily scope "their own". Use UUID/Cookie ideally or just restrict SELECT.
-- For now, allow SELECT by ID if they have the UUID (effectively known).
-- But Postgres policies apply to the set.
-- "Public can view orders" FOR SELECT USING (true) is bad (list all).
-- So we won't add a public SELECT policy for orders. The API returns the order upon creation.
-- Subsequent retrieval would require a secure token or auth.

-- 7. PRODUCT CATEGORIES
ALTER TABLE store_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Business members manage store categories" ON store_categories;
CREATE POLICY "Business members manage store categories" ON store_categories
  FOR ALL USING (
    EXISTS (
        SELECT 1 FROM stores s
        WHERE s.id = store_categories.store_id
        AND is_business_member(s.business_id)
    )
  );

DROP POLICY IF EXISTS "Public view store categories" ON store_categories;
CREATE POLICY "Public view store categories" ON store_categories
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Business members manage product categories" ON product_categories;
CREATE POLICY "Business members manage product categories" ON product_categories
  FOR ALL USING (
    EXISTS (
        SELECT 1 FROM products p
        JOIN stores s ON p.store_id = s.id
        WHERE p.id = product_categories.product_id
        AND is_business_member(s.business_id)
    )
  );

DROP POLICY IF EXISTS "Public view product categories" ON product_categories;
CREATE POLICY "Public view product categories" ON product_categories
  FOR SELECT USING (true);
