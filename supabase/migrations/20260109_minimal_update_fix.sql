-- MINIMAL FIX: Just the UPDATE policy for soft-delete
-- Run this SINGLE statement in Supabase SQL Editor

DROP POLICY IF EXISTS sessions_update_policy ON sessions;

CREATE POLICY sessions_update_policy ON sessions FOR UPDATE 
USING (
  creator_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM memberships m 
    WHERE m.business_id = sessions.business_id AND m.user_id = auth.uid()
  )
)
WITH CHECK (true);  -- Allow any update if USING passes
