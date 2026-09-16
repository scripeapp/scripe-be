-- Debug Function: Check Membership Logic
-- 20260107_debug_membership.sql

CREATE OR REPLACE FUNCTION public.debug_check_membership_logic(p_user_id UUID, p_business_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_is_member BOOLEAN;
  v_is_owner BOOLEAN;
  v_has_membership_row BOOLEAN;
BEGIN
  -- 1. Check direct function result
  v_is_member := is_business_member(p_business_id);
  
  -- 2. Check ownership table directly
  SELECT EXISTS(SELECT 1 FROM businesses WHERE id = p_business_id AND owner_user_id = p_user_id)
  INTO v_is_owner;
  
  -- 3. Check membership table directly
  SELECT EXISTS(SELECT 1 FROM memberships WHERE business_id = p_business_id AND user_id = p_user_id)
  INTO v_has_membership_row;

  RETURN jsonb_build_object(
    'is_business_member_func_result', v_is_member, -- This will run as YOU (postgres) not the target user unless we impersonate
    'is_owner_check', v_is_owner,
    'has_membership_row', v_has_membership_row
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Note: is_business_member checks auth.uid(). 
-- Running this function as postgres via RPC means auth.uid() is null/postgres.
-- We must impersonate inside the function or change how we test.

-- Improved version: Check tables directly without auth.uid() reliance for debug
CREATE OR REPLACE FUNCTION public.debug_simulate_check(p_user_id UUID, p_business_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_is_owner BOOLEAN;
  v_is_member BOOLEAN;
  v_membership_status TEXT;
BEGIN
    -- Check 1: Owner
    SELECT EXISTS(
        SELECT 1 FROM businesses 
        WHERE id = p_business_id 
        AND owner_user_id = p_user_id
    ) INTO v_is_owner;

    -- Check 2: Member (Active)
    SELECT EXISTS(
        SELECT 1 FROM memberships 
        WHERE business_id = p_business_id 
        AND user_id = p_user_id 
        AND status = 'active'
    ) INTO v_is_member;

    -- Check 3: Raw Status
    SELECT status INTO v_membership_status
    FROM memberships
    WHERE business_id = p_business_id 
    AND user_id = p_user_id
    LIMIT 1;

    RETURN jsonb_build_object(
        'user_id', p_user_id,
        'business_id', p_business_id,
        'is_owner__check', v_is_owner,
        'is_active_member__check', v_is_member,
        'raw_membership_status', v_membership_status
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
