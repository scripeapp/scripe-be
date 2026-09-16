-- ============================================================================
-- FIX: Drop remaining problematic RLS policies
-- Cleans up any remaining policies that use is_business_member on memberships
-- ============================================================================

-- Drop the policy that was missed
DROP POLICY IF EXISTS "Memberships viewable by business" ON memberships;

-- ============================================================================
-- FIX: Invitations RLS Policies
-- Business owners should be able to create and manage invitations
-- ============================================================================

-- Drop all existing invitations policies
DROP POLICY IF EXISTS "Invitations viewable by business or invitee" ON invitations;
DROP POLICY IF EXISTS "Invitations manageable by business" ON invitations;

-- Owners can view all invitations for their business
CREATE POLICY "Owners can view invitations" ON invitations
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM businesses b
      WHERE b.id = invitations.business_id
      AND b.owner_user_id = auth.uid()
    )
  );

-- Owners can create invitations
CREATE POLICY "Owners can create invitations" ON invitations
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM businesses b
      WHERE b.id = invitations.business_id
      AND b.owner_user_id = auth.uid()
    )
  );

-- Owners can update/delete invitations
CREATE POLICY "Owners can manage invitations" ON invitations
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM businesses b
      WHERE b.id = invitations.business_id
      AND b.owner_user_id = auth.uid()
    )
  );

-- Invitees can view invitations sent to them (by email match)
-- Using auth.jwt() ->> 'email' to match the invitation email
CREATE POLICY "Invitees can view their invitations" ON invitations
  FOR SELECT USING (email = auth.jwt()->>'email');

-- ============================================================================
-- FIX: Audit Logs RLS - Allow Owners to Write Logs
-- ============================================================================
DROP POLICY IF EXISTS "Audit logs viewable by business" ON audit_logs;
DROP POLICY IF EXISTS "Owners can view audit logs" ON audit_logs;

CREATE POLICY "Owners can view audit logs" ON audit_logs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM businesses b
      WHERE b.id = audit_logs.business_id
      AND b.owner_user_id = auth.uid()
    )
  );

CREATE POLICY "Owners can insert audit logs" ON audit_logs
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM businesses b
      WHERE b.id = audit_logs.business_id
      AND b.owner_user_id = auth.uid()
    )
  );

-- ============================================================================
-- FIX: Roles RLS - Ensure Owners can read all roles for their business
-- ============================================================================
DROP POLICY IF EXISTS "Custom roles viewable by business members" ON roles;
CREATE POLICY "Owners can view custom roles" ON roles
  FOR SELECT USING (
    is_system = FALSE AND
    EXISTS (
      SELECT 1 FROM businesses b
      WHERE b.id = roles.business_id
      AND b.owner_user_id = auth.uid()
    )
  );
