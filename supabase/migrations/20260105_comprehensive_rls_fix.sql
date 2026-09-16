-- ============================================================================
-- COMPREHENSIVE FIX: RLS Infinite Recursion
-- Root cause: is_business_member() queries memberships table, causing recursion
-- when used in memberships RLS policies.
-- 
-- Solution: Recreate the function with explicit SECURITY DEFINER and SET search_path
-- to ensure it properly bypasses RLS.
-- ============================================================================

-- ============================================================================
-- STEP 1: Drop ALL existing memberships policies
-- ============================================================================
DROP POLICY IF EXISTS "Business owners can manage memberships" ON memberships;
DROP POLICY IF EXISTS "Members can view team members" ON memberships;
DROP POLICY IF EXISTS "Users can read own memberships" ON memberships;
DROP POLICY IF EXISTS "Owners can read all business memberships" ON memberships;
DROP POLICY IF EXISTS "Owners can manage business memberships" ON memberships;
DROP POLICY IF EXISTS "Memberships viewable by business members" ON memberships;
DROP POLICY IF EXISTS "Memberships manageable by owners" ON memberships;

-- ============================================================================
-- STEP 2: Recreate is_business_member function with proper security context
-- The function MUST bypass RLS on memberships table
-- ============================================================================
CREATE OR REPLACE FUNCTION is_business_member(business_id_param UUID)
RETURNS BOOLEAN AS $$
DECLARE
  is_owner BOOLEAN;
  is_member BOOLEAN;
BEGIN
  -- Check if user is the business owner (queries businesses, not memberships)
  SELECT EXISTS (
    SELECT 1 FROM businesses 
    WHERE id = business_id_param 
    AND owner_user_id = auth.uid()
  ) INTO is_owner;
  
  IF is_owner THEN
    RETURN TRUE;
  END IF;
  
  -- Check if user is an active member
  -- SECURITY DEFINER ensures this bypasses RLS on memberships
  SELECT EXISTS (
    SELECT 1 FROM memberships 
    WHERE business_id = business_id_param 
    AND user_id = auth.uid() 
    AND status = 'active'
  ) INTO is_member;
  
  RETURN is_member;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- STEP 3: Create simple, non-recursive memberships policies
-- These policies MUST NOT use is_business_member() to avoid recursion
-- ============================================================================

-- Users can read their own membership records
CREATE POLICY "Users can read own memberships" ON memberships
  FOR SELECT USING (user_id = auth.uid());

-- Business owners can read all memberships for their business
CREATE POLICY "Owners can read business memberships" ON memberships
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM businesses b
      WHERE b.id = memberships.business_id
      AND b.owner_user_id = auth.uid()
    )
  );

-- Business owners can insert/update/delete memberships
CREATE POLICY "Owners can manage memberships" ON memberships
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM businesses b
      WHERE b.id = memberships.business_id
      AND b.owner_user_id = auth.uid()
    )
  );

-- ============================================================================
-- STEP 4: Fix businesses RLS to not cause issues
-- ============================================================================
DROP POLICY IF EXISTS "Businesses viewable by members" ON businesses;
DROP POLICY IF EXISTS "Owners can always read own businesses" ON businesses;
DROP POLICY IF EXISTS "Members can read businesses they belong to" ON businesses;

-- Owners can always see their businesses
CREATE POLICY "Owners can read own businesses" ON businesses
  FOR SELECT USING (owner_user_id = auth.uid());

-- Members can see businesses they belong to (uses is_business_member which now works)
CREATE POLICY "Members can read joined businesses" ON businesses
  FOR SELECT USING (is_business_member(id));

-- ============================================================================
-- STEP 5: Verify RLS is enabled
-- ============================================================================
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
