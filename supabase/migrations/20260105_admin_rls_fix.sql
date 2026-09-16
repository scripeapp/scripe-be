-- Add missing RLS policies for admin tables
-- This allows admins to at least see their own records so the middleware can validate them

-- 1. admin_users policies
DROP POLICY IF EXISTS "Admins can view their own record" ON admin_users;
CREATE POLICY "Admins can view their own record" ON admin_users
  FOR SELECT USING (auth.uid() = user_id);

-- Only super_admins can see all admin users
DROP POLICY IF EXISTS "Super admins can view all admin records" ON admin_users;
CREATE POLICY "Super admins can view all admin records" ON admin_users
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM admin_users 
      WHERE user_id = auth.uid() AND role = 'super_admin' AND is_active = TRUE
    )
  );

-- 2. admin_audit_logs policies
-- Admins can see logs they generated
DROP POLICY IF EXISTS "Admins can view their own audit logs" ON admin_audit_logs;
CREATE POLICY "Admins can view their own audit logs" ON admin_audit_logs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM admin_users 
      WHERE id = admin_audit_logs.admin_user_id AND user_id = auth.uid()
    )
  );

-- Super admins and support can see all audit logs
DROP POLICY IF EXISTS "Support and Super admins can view all audit logs" ON admin_audit_logs;
CREATE POLICY "Support and Super admins can view all audit logs" ON admin_audit_logs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM admin_users 
      WHERE user_id = auth.uid() AND role IN ('super_admin', 'support') AND is_active = TRUE
    )
  );

-- 3. admin_notes policies
-- Admins can see notes they created
DROP POLICY IF EXISTS "Admins can view their own notes" ON admin_notes;
CREATE POLICY "Admins can view their own notes" ON admin_notes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM admin_users 
      WHERE id = admin_notes.admin_user_id AND user_id = auth.uid()
    )
  );

-- Support and above can see all notes
DROP POLICY IF EXISTS "Staff can view all admin notes" ON admin_notes;
CREATE POLICY "Staff can view all admin notes" ON admin_notes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM admin_users 
      WHERE user_id = auth.uid() AND is_active = TRUE
    )
  );
