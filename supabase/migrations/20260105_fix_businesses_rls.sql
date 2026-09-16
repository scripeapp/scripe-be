-- ============================================================================
-- FIX: Businesses RLS - Allow Owners to Always Read Their Businesses
-- The policy was using is_business_member() which fails if membership is missing
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Businesses viewable by members" ON businesses;
DROP POLICY IF EXISTS "Authenticated users can read own businesses" ON businesses;

-- 1. OWNERS can always read their own businesses (no membership required)
CREATE POLICY "Owners can always read own businesses" ON businesses
  FOR SELECT USING (owner_user_id = auth.uid());

-- 2. MEMBERS (non-owners) can read businesses they're a member of
CREATE POLICY "Members can read businesses they belong to" ON businesses
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.business_id = businesses.id
      AND m.user_id = auth.uid()
      AND m.status = 'active'
    )
  );

-- Note: "Businesses manageable by owner" policy already exists for INSERT/UPDATE/DELETE
