-- RLS Policies for Stores and Related Tables (Business-aware)
-- This migration ensures that stores and their related entities 
-- are only accessible by members of the associated business.

-- 1. Enable RLS on all store-related tables
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
-- Note: 'orders' was renamed to 'store_orders' in a previous migration
ALTER TABLE store_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE discount_codes ENABLE ROW LEVEL SECURITY;

-- 2. Drop legacy policies if they exist (based on user_id)
DROP POLICY IF EXISTS "Users can view their own stores" ON stores;
DROP POLICY IF EXISTS "Users can insert their own stores" ON stores;
DROP POLICY IF EXISTS "Users can update their own stores" ON stores;
DROP POLICY IF EXISTS "Users can delete their own stores" ON stores;

-- 3. Public Read Access (for storefront)
DROP POLICY IF EXISTS "Public can view live stores" ON stores;
CREATE POLICY "Public can view live stores" ON stores
  FOR SELECT USING (is_live = TRUE);

DROP POLICY IF EXISTS "Public can view published products" ON products;
CREATE POLICY "Public can view published products" ON products
  FOR SELECT USING (status = 'published');

-- 4. Business Member Access (using is_business_member helper)
-- Note: is_business_member is defined in 20260104_teams_permissions_v2.sql

-- Stores
DROP POLICY IF EXISTS "Business members can view their stores" ON stores;
CREATE POLICY "Business members can view their stores" ON stores
  FOR SELECT USING (is_business_member(business_id));

DROP POLICY IF EXISTS "Business members can manage their stores" ON stores;
CREATE POLICY "Business members can manage their stores" ON stores
  FOR ALL USING (is_business_member(business_id));

-- Products (join with stores to get business_id)
DROP POLICY IF EXISTS "Business members can manage their products" ON products;
CREATE POLICY "Business members can manage their products" ON products
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM stores s 
      WHERE s.id = products.store_id 
      AND is_business_member(s.business_id)
    )
  );

-- Store Orders (join with stores to get business_id)
DROP POLICY IF EXISTS "Business members can manage their orders" ON store_orders;
CREATE POLICY "Business members can manage their orders" ON store_orders
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM stores s 
      WHERE s.id = store_orders.store_id 
      AND is_business_member(s.business_id)
    )
  );

-- Discount Codes (join with stores to get business_id)
DROP POLICY IF EXISTS "Business members can manage their discounts" ON discount_codes;
CREATE POLICY "Business members can manage their discounts" ON discount_codes
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM stores s 
      WHERE s.id = discount_codes.store_id 
      AND is_business_member(s.business_id)
    )
  );
