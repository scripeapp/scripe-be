-- ============================================================================
-- ALLOW MEMBERS TO VIEW CIRCLE MEMBER LIST
--
-- Problem: Only facilitators and creators could see the full member list.
-- Solution: Update RLS to allow any member of the circle to view the list.
-- ============================================================================

-- 1. Create helper to check if user is a member (includes admin check)
CREATE OR REPLACE FUNCTION is_circle_member(p_circle_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  -- 1. Check if user is already in the circle_members table (any role)
  IF EXISTS (
    SELECT 1 FROM circle_members
    WHERE circle_id = p_circle_id AND user_id = p_user_id
  ) THEN
    RETURN TRUE;
  END IF;

  -- 2. Check if user is a circle admin (creator, facilitator, or business owner)
  -- This reuses the logic from is_circle_admin
  IF is_circle_admin(p_circle_id, p_user_id) THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Update the SELECT policy
DROP POLICY IF EXISTS circle_members_select_policy ON circle_members;
CREATE POLICY circle_members_select_policy ON circle_members FOR SELECT USING (
  is_circle_member(circle_id, auth.uid())
);
