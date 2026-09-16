-- Food Store PRD Phase 1/2: RLS policies for store_branches, store_menus,
-- modifier_groups, modifier_options, product_modifier_groups.
--
-- These tables were created in 20260720_add_food_store_branches.sql and
-- 20260720_add_food_store_menus_modifiers.sql without any policies. RLS is
-- enabled by default on this project (see 20260105_public_access_rls.sql),
-- so every insert/select from the app's request-scoped (anon-key + user JWT)
-- client was being denied with 42501 and surfacing as a bare 500. Mirrors
-- the existing "Business members manage X" / "Public view X" pattern used
-- for store_categories.

-- 1. STORE BRANCHES
ALTER TABLE store_branches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Business members manage store branches" ON store_branches;
CREATE POLICY "Business members manage store branches" ON store_branches
  FOR ALL USING (
    EXISTS (
        SELECT 1 FROM stores s
        WHERE s.id = store_branches.store_id
        AND is_business_member(s.business_id)
    )
  );

DROP POLICY IF EXISTS "Public view active store branches" ON store_branches;
CREATE POLICY "Public view active store branches" ON store_branches
  FOR SELECT USING (is_active = true);

-- 2. STORE MENUS
ALTER TABLE store_menus ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Business members manage store menus" ON store_menus;
CREATE POLICY "Business members manage store menus" ON store_menus
  FOR ALL USING (
    EXISTS (
        SELECT 1 FROM stores s
        WHERE s.id = store_menus.store_id
        AND is_business_member(s.business_id)
    )
  );

DROP POLICY IF EXISTS "Public view active store menus" ON store_menus;
CREATE POLICY "Public view active store menus" ON store_menus
  FOR SELECT USING (is_active = true);

-- 3. MODIFIER GROUPS
ALTER TABLE modifier_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Business members manage modifier groups" ON modifier_groups;
CREATE POLICY "Business members manage modifier groups" ON modifier_groups
  FOR ALL USING (
    EXISTS (
        SELECT 1 FROM stores s
        WHERE s.id = modifier_groups.store_id
        AND is_business_member(s.business_id)
    )
  );

DROP POLICY IF EXISTS "Public view modifier groups" ON modifier_groups;
CREATE POLICY "Public view modifier groups" ON modifier_groups
  FOR SELECT USING (true);

-- 4. MODIFIER OPTIONS (scoped via parent modifier_groups.store_id)
ALTER TABLE modifier_options ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Business members manage modifier options" ON modifier_options;
CREATE POLICY "Business members manage modifier options" ON modifier_options
  FOR ALL USING (
    EXISTS (
        SELECT 1 FROM modifier_groups mg
        JOIN stores s ON s.id = mg.store_id
        WHERE mg.id = modifier_options.modifier_group_id
        AND is_business_member(s.business_id)
    )
  );

DROP POLICY IF EXISTS "Public view modifier options" ON modifier_options;
CREATE POLICY "Public view modifier options" ON modifier_options
  FOR SELECT USING (true);

-- 5. PRODUCT <-> MODIFIER GROUP ATTACHMENT (scoped via products.store_id)
ALTER TABLE product_modifier_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Business members manage product modifier groups" ON product_modifier_groups;
CREATE POLICY "Business members manage product modifier groups" ON product_modifier_groups
  FOR ALL USING (
    EXISTS (
        SELECT 1 FROM products p
        JOIN stores s ON p.store_id = s.id
        WHERE p.id = product_modifier_groups.product_id
        AND is_business_member(s.business_id)
    )
  );

DROP POLICY IF EXISTS "Public view product modifier groups" ON product_modifier_groups;
CREATE POLICY "Public view product modifier groups" ON product_modifier_groups
  FOR SELECT USING (true);
