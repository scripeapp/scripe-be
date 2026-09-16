-- Fix is_business_member to bypass RLS on lookup tables
-- The function needs to bypass RLS when checking businesses and memberships

-- This version sets row_security = off to bypass RLS during checks
CREATE OR REPLACE FUNCTION is_business_member(business_id_param UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_user_id UUID;
  is_owner BOOLEAN := FALSE;
  is_member BOOLEAN := FALSE;
BEGIN
  -- Get the current user ID from JWT
  v_user_id := auth.uid();
  
  -- Early return if no authenticated user
  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;
  
  -- Check 1: Is user the business owner?
  -- Use direct table access (SECURITY DEFINER bypasses RLS)
  PERFORM set_config('row_security', 'off', true);
  
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
  
  -- Reset row security
  PERFORM set_config('row_security', 'on', true);
  
  RETURN is_member;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION is_business_member(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION is_business_member(UUID) TO anon;
