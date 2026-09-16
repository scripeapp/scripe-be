-- Fix Session UPDATE RLS: Allow soft-delete operations
-- The UPDATE policy needs to allow setting deleted_at

-- ============================================================================
-- FIX: Sessions UPDATE Policy - Must allow soft delete
-- ============================================================================

-- Drop and recreate with proper conditions
DROP POLICY IF EXISTS sessions_update_policy ON sessions;
CREATE POLICY sessions_update_policy ON sessions FOR UPDATE USING (
  -- Can update if session is not already deleted
  deleted_at IS NULL
  AND (
    -- Creator can update their sessions
    creator_id = auth.uid()
    -- Business members can update
    OR EXISTS (
      SELECT 1 FROM memberships m 
      WHERE m.business_id = sessions.business_id AND m.user_id = auth.uid()
    )
  )
) WITH CHECK (
  -- Allow any valid update (including setting deleted_at)
  creator_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM memberships m 
    WHERE m.business_id = sessions.business_id AND m.user_id = auth.uid()
  )
);

-- ============================================================================
-- FIX: Session SELECT Policy - Creator must see their deleted sessions too
-- (So they can verify deletion worked, and for audit purposes)
-- ============================================================================

DROP POLICY IF EXISTS sessions_select_policy ON sessions;
CREATE POLICY sessions_select_policy ON sessions FOR SELECT USING (
  -- Public non-deleted sessions visible to everyone
  (deleted_at IS NULL AND visibility = 'public')
  -- Creator can always see ALL their sessions (including deleted)
  OR creator_id = auth.uid()
  -- Business members can see non-deleted sessions
  OR (deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM memberships m 
    WHERE m.business_id = sessions.business_id AND m.user_id = auth.uid()
  ))
);
