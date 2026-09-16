-- FINAL FIX: Completely hide deleted sessions from everyone
-- No exceptions - deleted sessions should NEVER be visible

-- ============================================================================
-- 1. SESSIONS SELECT: Deleted sessions are COMPLETELY hidden
-- ============================================================================

DROP POLICY IF EXISTS sessions_select_policy ON sessions;
CREATE POLICY sessions_select_policy ON sessions FOR SELECT USING (
  -- MUST NOT be deleted - this is the first check, no exceptions
  deleted_at IS NULL
  AND (
    -- Then check visibility permissions as normal
    visibility = 'public'
    OR creator_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM memberships m 
      WHERE m.business_id = sessions.business_id AND m.user_id = auth.uid()
    )
  )
);

-- ============================================================================
-- 2. SESSIONS UPDATE: Allow soft-delete (setting deleted_at)
-- ============================================================================

DROP POLICY IF EXISTS sessions_update_policy ON sessions;
CREATE POLICY sessions_update_policy ON sessions FOR UPDATE 
USING (
  -- Can only update non-deleted sessions
  deleted_at IS NULL
  AND (
    creator_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM memberships m 
      WHERE m.business_id = sessions.business_id AND m.user_id = auth.uid()
    )
  )
)
WITH CHECK (
  -- The updated row can have deleted_at set (for soft delete)
  -- But creator_id must match
  creator_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM memberships m 
    WHERE m.business_id = sessions.business_id AND m.user_id = auth.uid()
  )
);

-- ============================================================================
-- 3. BUSINESSES FOR PUBLIC SESSIONS: Fix the join to return business data
-- ============================================================================

-- Drop any conflicting policies first
DROP POLICY IF EXISTS businesses_public_session_visibility ON businesses;
DROP POLICY IF EXISTS businesses_select_policy ON businesses;

-- Create a comprehensive businesses SELECT policy
CREATE POLICY businesses_select_policy ON businesses FOR SELECT USING (
  -- User is a business member (covers owners via membership)
  EXISTS (
    SELECT 1 FROM memberships m 
    WHERE m.business_id = businesses.id AND m.user_id = auth.uid()
  )
  -- Business has a public session (for anonymous/other users to see business name)
  OR EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.business_id = businesses.id 
    AND s.visibility = 'public' 
    AND s.deleted_at IS NULL
  )
);

-- ============================================================================
-- 4. SESSION_MEMBERS: Don't show members of deleted sessions
-- ============================================================================

DROP POLICY IF EXISTS session_members_select_policy ON session_members;
CREATE POLICY session_members_select_policy ON session_members FOR SELECT USING (
  -- Session must not be deleted
  EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_members.session_id 
    AND s.deleted_at IS NULL
  )
  AND (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM sessions s 
      WHERE s.id = session_members.session_id 
      AND s.creator_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM sessions s 
      JOIN memberships m ON m.business_id = s.business_id
      WHERE s.id = session_members.session_id 
      AND m.user_id = auth.uid()
    )
  )
);
