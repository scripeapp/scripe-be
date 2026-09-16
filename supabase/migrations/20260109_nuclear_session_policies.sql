-- NUCLEAR OPTION: Drop and recreate ALL session policies cleanly
-- Run this in Supabase SQL Editor

-- First, check the session state
SELECT id, title, creator_id, deleted_at, visibility 
FROM sessions 
WHERE id = '032a8f79-5c98-4387-9d8e-8aed01e7aa5f';

-- Drop ALL existing policies on sessions
DROP POLICY IF EXISTS sessions_select_policy ON sessions;
DROP POLICY IF EXISTS sessions_insert_policy ON sessions;
DROP POLICY IF EXISTS sessions_update_policy ON sessions;
DROP POLICY IF EXISTS sessions_delete_policy ON sessions;

-- Recreate policies from scratch

-- 1. SELECT: Can see non-deleted public sessions, or own sessions, or business sessions
CREATE POLICY sessions_select_policy ON sessions FOR SELECT USING (
  deleted_at IS NULL
  AND (
    visibility = 'public'
    OR creator_id = auth.uid()
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.business_id = sessions.business_id AND m.user_id = auth.uid())
  )
);

-- 2. INSERT: Creator or business member can insert
CREATE POLICY sessions_insert_policy ON sessions FOR INSERT WITH CHECK (
  creator_id = auth.uid()
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.business_id = sessions.business_id AND m.user_id = auth.uid())
);

-- 3. UPDATE: Creator or business member can update ANY field (including deleted_at)
CREATE POLICY sessions_update_policy ON sessions FOR UPDATE 
USING (
  creator_id = auth.uid()
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.business_id = sessions.business_id AND m.user_id = auth.uid())
)
WITH CHECK (true);

-- 4. DELETE: Creator or business member can hard delete
CREATE POLICY sessions_delete_policy ON sessions FOR DELETE USING (
  creator_id = auth.uid()
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.business_id = sessions.business_id AND m.user_id = auth.uid())
);

-- Verify the policies
SELECT policyname, cmd, with_check FROM pg_policies WHERE tablename = 'sessions';
