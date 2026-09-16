-- Fix Session Soft-Delete RLS Policy
-- The UPDATE policy's USING clause was blocking soft-delete because it required deleted_at IS NULL
-- This migration removes that check so soft-delete (setting deleted_at) can succeed

-- ============================================================================
-- FIX: Sessions UPDATE Policy - Remove deleted_at check to allow soft-delete
-- ============================================================================

DROP POLICY IF EXISTS sessions_update_policy ON sessions;

CREATE POLICY sessions_update_policy ON sessions FOR UPDATE 
USING (
  -- Can update if user is creator or business member
  -- No deleted_at check here - allows soft-delete to work
  creator_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM memberships m 
    WHERE m.business_id = sessions.business_id AND m.user_id = auth.uid()
  )
)
WITH CHECK (true);  -- Allow any update if USING passes
