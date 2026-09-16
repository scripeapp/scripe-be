-- Debug and Fix is_business_member Function
-- This migration investigates and fixes the is_business_member function

-- Step 1: Create a debug function to test auth.uid() from RLS context
CREATE OR REPLACE FUNCTION debug_auth_context()
RETURNS TABLE(
  user_uid UUID,
  pg_role TEXT,
  session_user_name TEXT
) AS $$
BEGIN
  RETURN QUERY SELECT 
    auth.uid() as user_uid,
    current_user::TEXT as pg_role,
    session_user::TEXT as session_user_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Step 2: Check current is_business_member definition
-- The function should:
-- 1. Be SECURITY DEFINER (to bypass RLS on memberships)
-- 2. Check businesses.owner_user_id first
-- 3. Check memberships as fallback

-- Step 3: Recreate is_business_member with explicit checks and debugging
-- Note: Using CREATE OR REPLACE (not DROP) because policies depend on this function
CREATE OR REPLACE FUNCTION is_business_member(business_id_param UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_user_id UUID;
  is_owner BOOLEAN := FALSE;
  is_member BOOLEAN := FALSE;
BEGIN
  -- Get the current user ID
  v_user_id := auth.uid();
  
  -- Early return if no authenticated user
  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;
  
  -- Check 1: Is user the business owner?
  SELECT EXISTS (
    SELECT 1 FROM businesses 
    WHERE id = business_id_param 
    AND owner_user_id = v_user_id
  ) INTO is_owner;
  
  IF is_owner THEN
    RETURN TRUE;
  END IF;
  
  -- Check 2: Is user an active team member?
  SELECT EXISTS (
    SELECT 1 FROM memberships 
    WHERE business_id = business_id_param 
    AND user_id = v_user_id 
    AND status = 'active'
  ) INTO is_member;
  
  RETURN is_member;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION is_business_member(UUID) TO authenticated;

-- Step 4: Verify the function works with a test
-- Run: SELECT is_business_member('1213b6a6-8528-4203-9a21-629d595c8b5d');
