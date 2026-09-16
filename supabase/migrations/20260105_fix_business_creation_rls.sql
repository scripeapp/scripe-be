-- ============================================================================
-- FIX: Business Creation RLS Policies
-- Enables users to create businesses and self-assign the Owner membership
-- ============================================================================

-- 1. BUSINESSES TABLE
-- Allow authenticated users to create a business (becoming the owner)
DROP POLICY IF EXISTS "Authenticated users can create businesses" ON businesses;
CREATE POLICY "Authenticated users can create businesses" ON businesses
  FOR INSERT WITH CHECK (owner_user_id = auth.uid());

-- 2. MEMBERSHIPS TABLE
-- Allow business owners to insert memberships (for themselves or others)
-- Essential for the initial bootstrapping step where the owner adds themselves.
DROP POLICY IF EXISTS "Business owners can manage memberships" ON memberships;
CREATE POLICY "Business owners can manage memberships" ON memberships
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM businesses b
      WHERE b.id = memberships.business_id
      AND b.owner_user_id = auth.uid()
    )
  );

-- 3. ROLES TABLE (Just in case)
-- Ensure owners can read all roles to find the 'Owner' role ID
DROP POLICY IF EXISTS "Authenticated users can read all roles" ON roles;
CREATE POLICY "Authenticated users can read all roles" ON roles
  FOR SELECT USING (true);
