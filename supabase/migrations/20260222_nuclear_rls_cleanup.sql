-- NUCLEAR RLS CLEANUP
-- Drops all known and potential policy names to ensure a clean slate.

-- 1. Drop ALL potential policies on circle_members
DROP POLICY IF EXISTS circle_members_insert_policy ON circle_members;
DROP POLICY IF EXISTS session_members_insert_policy ON circle_members;
DROP POLICY IF EXISTS circle_members_select_policy ON circle_members;
DROP POLICY IF EXISTS session_members_select_policy ON circle_members;
DROP POLICY IF EXISTS circle_members_update_policy ON circle_members;
DROP POLICY IF EXISTS session_members_update_policy ON circle_members;
DROP POLICY IF EXISTS circle_members_delete_policy ON circle_members;
DROP POLICY IF EXISTS session_members_delete_policy ON circle_members;
DROP POLICY IF EXISTS "Anyone can join public circles" ON circle_members;
DROP POLICY IF EXISTS "Members can view themselves" ON circle_members;

-- 2. Drop ALL potential policies on circles
DROP POLICY IF EXISTS circles_select_policy ON circles;
DROP POLICY IF EXISTS sessions_select_policy ON circles;
DROP POLICY IF EXISTS circles_insert_policy ON circles;
DROP POLICY IF EXISTS sessions_insert_policy ON circles;
DROP POLICY IF EXISTS circles_update_policy ON circles;
DROP POLICY IF EXISTS sessions_update_policy ON circles;
DROP POLICY IF EXISTS circles_delete_policy ON circles;
DROP POLICY IF EXISTS sessions_delete_policy ON circles;

-- 3. Drop OUR OWN permissive policies (to make the script idempotent)
DROP POLICY IF EXISTS circle_members_permissive_insert ON circle_members;
DROP POLICY IF EXISTS circle_members_permissive_select ON circle_members;
DROP POLICY IF EXISTS circle_members_permissive_delete ON circle_members;
DROP POLICY IF EXISTS circle_members_permissive_update ON circle_members;
DROP POLICY IF EXISTS circles_permissive_select ON circles;
DROP POLICY IF EXISTS circles_permissive_update ON circles;
DROP POLICY IF EXISTS circles_permissive_insert ON circles;

-- 4. Create extremely permissive policies for testing
ALTER TABLE circle_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY circle_members_permissive_insert ON circle_members 
  FOR INSERT WITH CHECK (true);

CREATE POLICY circle_members_permissive_select ON circle_members 
  FOR SELECT USING (true);

CREATE POLICY circle_members_permissive_delete ON circle_members 
  FOR DELETE USING (true);

CREATE POLICY circle_members_permissive_update ON circle_members 
  FOR UPDATE USING (true) WITH CHECK (true);

ALTER TABLE circles ENABLE ROW LEVEL SECURITY;
CREATE POLICY circles_permissive_select ON circles 
  FOR SELECT USING (true);

CREATE POLICY circles_permissive_update ON circles 
  FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY circles_permissive_insert ON circles 
  FOR INSERT WITH CHECK (true);

-- 4. Verify (Run this in SQL editor to see what's left)
-- SELECT policyname, tablename, cmd, qual, with_check 
-- FROM pg_policies 
-- WHERE tablename IN ('circle_members', 'circles');
