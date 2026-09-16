-- Fix Infinite Recursion in Admin Policies
-- 20260107_fix_admin_recursion.sql

-- 1. Create a helper function to break recursion
-- This function runs as the table owner (SECURITY DEFINER) to check status 
-- without triggering RLS policies on the table itself recursively.
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM admin_users 
    WHERE user_id = auth.uid() 
    AND role = 'super_admin' 
    AND is_active = TRUE
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Update the Policy to use the helper function
DROP POLICY IF EXISTS "Super admins can view all admin records" ON admin_users;

CREATE POLICY "Super admins can view all admin records" ON admin_users
  FOR SELECT USING (
    public.is_super_admin()
  );

-- 3. Also update Audit Logs policies which relied on similar logic
DROP POLICY IF EXISTS "Support and Super admins can view all audit logs" ON admin_audit_logs;

CREATE POLICY "Support and Super admins can view all audit logs" ON admin_audit_logs
  FOR SELECT USING (
    EXISTS (
       SELECT 1 FROM admin_users 
       WHERE user_id = auth.uid() 
       AND role IN ('super_admin', 'support') 
       AND is_active = TRUE
    )
  );
  
-- Note: The audit log policy might NOT recurse if it doesn't select from audit_logs, 
-- but selecting from admin_users inside it is safe IF admin_users has no recursive policy.
-- However, query optimization 'might' still trigger issues. 
-- Best to use the function or ensure admin_users policy is clean. 
-- The fix above (step 2) cleans admin_users policy, so other tables querying it should be safe now.
