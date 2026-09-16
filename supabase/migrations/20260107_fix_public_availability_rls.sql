-- Fix public access for availability profiles and delivery methods
-- 20260107_fix_public_availability_rls.sql

-- 1. Availability Profiles
-- Allow public (anon/authenticated) to view profiles linked to products they can see
DROP POLICY IF EXISTS "Public can view availability profiles" ON availability_profiles;
CREATE POLICY "Public can view availability profiles" ON availability_profiles
  FOR SELECT USING (
    status = 'active'
  );

-- 2. Delivery Methods
ALTER TABLE store_delivery_methods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Business members manage delivery methods" ON store_delivery_methods;
CREATE POLICY "Business members manage delivery methods" ON store_delivery_methods
  FOR ALL USING (
    EXISTS (
        SELECT 1 FROM stores s
        WHERE s.id = store_delivery_methods.store_id
        AND (s.user_id = auth.uid() OR is_business_member(s.business_id))
    )
  );

DROP POLICY IF EXISTS "Public can view active delivery methods" ON store_delivery_methods;
CREATE POLICY "Public can view active delivery methods" ON store_delivery_methods
  FOR SELECT USING (is_active = true);

-- 3. Delivery Integrations (Public can see which are enabled)
ALTER TABLE store_delivery_integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Business members manage delivery integrations" ON store_delivery_integrations;
CREATE POLICY "Business members manage delivery integrations" ON store_delivery_integrations
  FOR ALL USING (
    EXISTS (
        SELECT 1 FROM stores s
        WHERE s.id = store_delivery_integrations.store_id
        AND (s.user_id = auth.uid() OR is_business_member(s.business_id))
    )
  );

DROP POLICY IF EXISTS "Public can view delivery integrations" ON store_delivery_integrations;
CREATE POLICY "Public can view delivery integrations" ON store_delivery_integrations
  FOR SELECT USING (is_enabled = true);
