-- Fix infinite recursion in session_members RLS policies
-- The issue is that policies on session_members were checking session_members itself

-- Session Members: Use simpler policies to avoid recursion

-- SELECT: Any authenticated user can read session members
-- (in practice, controller-level auth filters results)
DROP POLICY IF EXISTS session_members_select_policy ON session_members;
CREATE POLICY session_members_select_policy ON session_members FOR SELECT USING (
  -- User can always see their own membership
  user_id = auth.uid()
  -- Or they're the session creator
  OR EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_members.session_id 
    AND s.creator_id = auth.uid()
  )
  -- Simplify: business members can see members too
  OR EXISTS (
    SELECT 1 FROM sessions s 
    JOIN memberships m ON m.business_id = s.business_id
    WHERE s.id = session_members.session_id 
    AND m.user_id = auth.uid()
  )
);

-- INSERT: Non-recursive - check session directly
DROP POLICY IF EXISTS session_members_insert_policy ON session_members;
CREATE POLICY session_members_insert_policy ON session_members FOR INSERT WITH CHECK (
  -- User joining themselves to a public session
  (user_id = auth.uid() AND EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_members.session_id 
    AND s.visibility = 'public'
  ))
  -- Or creator adding members
  OR EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_members.session_id 
    AND s.creator_id = auth.uid()
  )
  -- Or business member adding members
  OR EXISTS (
    SELECT 1 FROM sessions s 
    JOIN memberships m ON m.business_id = s.business_id
    WHERE s.id = session_members.session_id 
    AND m.user_id = auth.uid()
  )
);

-- UPDATE: Non-recursive
DROP POLICY IF EXISTS session_members_update_policy ON session_members;
CREATE POLICY session_members_update_policy ON session_members FOR UPDATE USING (
  -- Creator can update
  EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_members.session_id 
    AND s.creator_id = auth.uid()
  )
  -- Or business member
  OR EXISTS (
    SELECT 1 FROM sessions s 
    JOIN memberships m ON m.business_id = s.business_id
    WHERE s.id = session_members.session_id 
    AND m.user_id = auth.uid()
  )
);

-- DELETE: Non-recursive
DROP POLICY IF EXISTS session_members_delete_policy ON session_members;
CREATE POLICY session_members_delete_policy ON session_members FOR DELETE USING (
  -- User can remove themselves
  user_id = auth.uid()
  -- Or creator can remove
  OR EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_members.session_id 
    AND s.creator_id = auth.uid()
  )
  -- Or business member
  OR EXISTS (
    SELECT 1 FROM sessions s 
    JOIN memberships m ON m.business_id = s.business_id
    WHERE s.id = session_members.session_id 
    AND m.user_id = auth.uid()
  )
);

-- Also fix Session Tags, Occurrences policies that have same issue

-- SESSION TAGS: Remove recursive session_members checks
DROP POLICY IF EXISTS session_tags_insert_policy ON session_tags;
CREATE POLICY session_tags_insert_policy ON session_tags FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_tags.session_id 
    AND s.creator_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM sessions s 
    JOIN memberships m ON m.business_id = s.business_id
    WHERE s.id = session_tags.session_id 
    AND m.user_id = auth.uid()
  )
);

DROP POLICY IF EXISTS session_tags_update_policy ON session_tags;
CREATE POLICY session_tags_update_policy ON session_tags FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_tags.session_id 
    AND s.creator_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM sessions s 
    JOIN memberships m ON m.business_id = s.business_id
    WHERE s.id = session_tags.session_id 
    AND m.user_id = auth.uid()
  )
);

DROP POLICY IF EXISTS session_tags_delete_policy ON session_tags;
CREATE POLICY session_tags_delete_policy ON session_tags FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_tags.session_id 
    AND s.creator_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM sessions s 
    JOIN memberships m ON m.business_id = s.business_id
    WHERE s.id = session_tags.session_id 
    AND m.user_id = auth.uid()
  )
);

-- SESSION OCCURRENCES: Remove recursive session_members checks
DROP POLICY IF EXISTS session_occurrences_insert_policy ON session_occurrences;
CREATE POLICY session_occurrences_insert_policy ON session_occurrences FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_occurrences.session_id 
    AND s.creator_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM sessions s 
    JOIN memberships m ON m.business_id = s.business_id
    WHERE s.id = session_occurrences.session_id 
    AND m.user_id = auth.uid()
  )
);

DROP POLICY IF EXISTS session_occurrences_update_policy ON session_occurrences;
CREATE POLICY session_occurrences_update_policy ON session_occurrences FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_occurrences.session_id 
    AND s.creator_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM sessions s 
    JOIN memberships m ON m.business_id = s.business_id
    WHERE s.id = session_occurrences.session_id 
    AND m.user_id = auth.uid()
  )
);

DROP POLICY IF EXISTS session_occurrences_delete_policy ON session_occurrences;
CREATE POLICY session_occurrences_delete_policy ON session_occurrences FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_occurrences.session_id 
    AND s.creator_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM sessions s 
    JOIN memberships m ON m.business_id = s.business_id
    WHERE s.id = session_occurrences.session_id 
    AND m.user_id = auth.uid()
  )
);

-- SESSIONS: Remove recursive session_members checks from sessions policies
DROP POLICY IF EXISTS sessions_select_policy ON sessions;
CREATE POLICY sessions_select_policy ON sessions FOR SELECT USING (
  visibility = 'public'
  OR creator_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM memberships m 
    WHERE m.business_id = sessions.business_id AND m.user_id = auth.uid()
  )
);

DROP POLICY IF EXISTS sessions_update_policy ON sessions;
CREATE POLICY sessions_update_policy ON sessions FOR UPDATE USING (
  creator_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM memberships m 
    WHERE m.business_id = sessions.business_id AND m.user_id = auth.uid()
  )
);
