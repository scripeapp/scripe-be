-- Fix Session RLS: Exclude soft-deleted sessions and ensure business visibility
-- This addresses the "blank page" issue where deleted sessions are returned with null business

-- ============================================================================
-- 1. FIX SESSIONS SELECT POLICY: Exclude soft-deleted sessions
-- ============================================================================

DROP POLICY IF EXISTS sessions_select_policy ON sessions;
CREATE POLICY sessions_select_policy ON sessions FOR SELECT USING (
  -- Must not be soft-deleted
  deleted_at IS NULL
  AND (
    -- Public sessions are visible to everyone
    visibility = 'public'
    -- Creator can always see their sessions
    OR creator_id = auth.uid()
    -- Business members can see business sessions
    OR EXISTS (
      SELECT 1 FROM memberships m 
      WHERE m.business_id = sessions.business_id AND m.user_id = auth.uid()
    )
  )
);

-- ============================================================================
-- 2. FIX BUSINESSES SELECT POLICY: Allow reading business for public sessions
-- ============================================================================

-- First, check if there's an existing policy we need to preserve
-- We'll add an OR condition to allow business visibility for public sessions

DROP POLICY IF EXISTS businesses_public_session_visibility ON businesses;
CREATE POLICY businesses_public_session_visibility ON businesses FOR SELECT USING (
  -- User is a member of the business (existing behavior)
  EXISTS (
    SELECT 1 FROM memberships m 
    WHERE m.business_id = businesses.id AND m.user_id = auth.uid()
  )
  -- OR business has a public, non-deleted session (new: allows anonymous users to see business name)
  OR EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.business_id = businesses.id 
    AND s.visibility = 'public' 
    AND s.deleted_at IS NULL
  )
);

-- ============================================================================
-- 3. UPDATE SESSION_MEMBERS SELECT: Add deleted_at check to prevent orphan members
-- ============================================================================

DROP POLICY IF EXISTS session_members_select_policy ON session_members;
CREATE POLICY session_members_select_policy ON session_members FOR SELECT USING (
  -- Only for non-deleted sessions
  EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_members.session_id 
    AND s.deleted_at IS NULL
  )
  AND (
    -- User can see their own membership
    user_id = auth.uid()
    -- Or they're the session creator
    OR EXISTS (
      SELECT 1 FROM sessions s 
      WHERE s.id = session_members.session_id 
      AND s.creator_id = auth.uid()
    )
    -- Or they're a business member
    OR EXISTS (
      SELECT 1 FROM sessions s 
      JOIN memberships m ON m.business_id = s.business_id
      WHERE s.id = session_members.session_id 
      AND m.user_id = auth.uid()
    )
  )
);
