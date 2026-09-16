-- ============================================================================
-- FIX: Remove Infinite Recursion in Memberships RLS
-- The previous policy caused infinite recursion by querying memberships to
-- check access to memberships. Now using simpler, non-recursive policies.
-- ============================================================================

-- Drop ALL existing memberships policies to start fresh
DROP POLICY IF EXISTS "Business owners can manage memberships" ON memberships;
DROP POLICY IF EXISTS "Members can view team members" ON memberships;
DROP POLICY IF EXISTS "Users can read own memberships" ON memberships;

-- 1. Users can ALWAYS read their own memberships (no recursion)
CREATE POLICY "Users can read own memberships" ON memberships
  FOR SELECT USING (user_id = auth.uid());

-- 2. Users can read memberships of businesses they OWN (via businesses table, not recursion)
CREATE POLICY "Owners can read all business memberships" ON memberships
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM businesses b
      WHERE b.id = memberships.business_id
      AND b.owner_user_id = auth.uid()
    )
  );

-- 3. Owners can INSERT/UPDATE/DELETE memberships for their businesses
CREATE POLICY "Owners can manage business memberships" ON memberships
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM businesses b
      WHERE b.id = memberships.business_id
      AND b.owner_user_id = auth.uid()
    )
  );

-- Note: Team members viewing OTHER team members requires a two-step approach:
-- The API layer (controller) handles this by first getting user's own membership,
-- then using that business_id to query other members.
