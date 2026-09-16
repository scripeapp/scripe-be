-- Fix Session Triggers and RLS Policies
-- ROOT CAUSE: Trigger functions lack SECURITY DEFINER, causing RLS failures
-- when trying to update cached counts on sessions table

-- ============================================================================
-- 1. FIX: Add SECURITY DEFINER to trigger functions
-- ============================================================================

-- Fix members count trigger function
CREATE OR REPLACE FUNCTION update_session_members_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE sessions 
    SET cached_members_count = cached_members_count + 1 
    WHERE id = NEW.session_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE sessions 
    SET cached_members_count = GREATEST(0, cached_members_count - 1)
    WHERE id = OLD.session_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Fix occurrences count trigger function
CREATE OR REPLACE FUNCTION update_session_occurrences_count()
RETURNS TRIGGER AS $$
DECLARE
  affected_session_id UUID;
BEGIN
  -- Determine which session to update
  IF TG_OP = 'DELETE' THEN
    affected_session_id := OLD.session_id;
  ELSE
    affected_session_id := NEW.session_id;
  END IF;

  -- Recalculate count for the affected session
  UPDATE sessions 
  SET cached_upcoming_occurrences_count = (
    SELECT COUNT(*) 
    FROM session_occurrences
    WHERE session_id = affected_session_id
    AND start_datetime > NOW()
  ) 
  WHERE id = affected_session_id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- 2. FIX: Sessions UPDATE Policy - Allow soft-delete and trigger updates
-- ============================================================================

DROP POLICY IF EXISTS sessions_update_policy ON sessions;

CREATE POLICY sessions_update_policy ON sessions FOR UPDATE 
USING (
  -- Creator or business member can update
  creator_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM memberships m 
    WHERE m.business_id = sessions.business_id AND m.user_id = auth.uid()
  )
)
WITH CHECK (true);  -- Allow any update if USING passes (enables soft-delete)

-- ============================================================================
-- 3. Verify by listing current policies
-- ============================================================================

-- Run this SELECT to verify the policy was created correctly:
-- SELECT policyname, cmd, with_check FROM pg_policies WHERE tablename = 'sessions';
