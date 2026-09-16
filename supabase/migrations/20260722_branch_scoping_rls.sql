-- Branch-aware storefront, part 5: RLS policies for the two new tables
-- (product_branch_overrides, store_delivery_zones). Mirrors the
-- "Business members manage X" / "Public view X" pattern established in
-- 20260721_food_store_rls_policies.sql. New columns added to existing
-- tables (modifier_groups.branch_ids, modifier_options.branch_ids,
-- store_branches.tax_rate/manager/format, store_orders.tax_amount) need no
-- new policies — those tables already have RLS enabled.

-- 1. PRODUCT BRANCH OVERRIDES (scoped via parent products.store_id)
ALTER TABLE product_branch_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Business members manage product branch overrides" ON product_branch_overrides;
CREATE POLICY "Business members manage product branch overrides" ON product_branch_overrides
  FOR ALL USING (
    EXISTS (
        SELECT 1 FROM products p
        JOIN stores s ON p.store_id = s.id
        WHERE p.id = product_branch_overrides.product_id
        AND is_business_member(s.business_id)
    )
  );

DROP POLICY IF EXISTS "Public view product branch overrides" ON product_branch_overrides;
CREATE POLICY "Public view product branch overrides" ON product_branch_overrides
  FOR SELECT USING (true);

-- 2. STORE DELIVERY ZONES
ALTER TABLE store_delivery_zones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Business members manage store delivery zones" ON store_delivery_zones;
CREATE POLICY "Business members manage store delivery zones" ON store_delivery_zones
  FOR ALL USING (
    EXISTS (
        SELECT 1 FROM stores s
        WHERE s.id = store_delivery_zones.store_id
        AND is_business_member(s.business_id)
    )
  );

DROP POLICY IF EXISTS "Public view active store delivery zones" ON store_delivery_zones;
CREATE POLICY "Public view active store delivery zones" ON store_delivery_zones
  FOR SELECT USING (is_active = true);
