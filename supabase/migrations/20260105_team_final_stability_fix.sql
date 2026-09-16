-- ============================================================================
-- TEAM SYSTEM — FINAL STABILITY FIX
-- This migration provides a clean, non-recursive RLS setup for ALL team tables.
-- It replaces all previous overlapping or recursive policies.
-- ============================================================================

-- ============================================================================
-- 1. CLEANUP: Drop all previous policies to avoid conflicts
-- ============================================================================
DO $$ 
DECLARE 
    r RECORD;
BEGIN
    FOR r IN (
        SELECT policyname, tablename 
        FROM pg_policies 
        WHERE schemaname = 'public' 
        AND tablename IN (
            'businesses', 
            'memberships', 
            'invitations', 
            'roles', 
            'role_permissions', 
            'audit_logs',
            'permissions',
            'users'
        )
    ) LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.policyname, r.tablename);
    END LOOP;
END $$;

-- ============================================================================
-- 2. HELPER FUNCTIONS (Defined FIRST so policies can use them)
-- ============================================================================

-- Check if user is an active member (ONLY checks memberships, NO recursion)
CREATE OR REPLACE FUNCTION is_business_member(business_id_param UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM memberships 
    WHERE business_id = business_id_param 
    AND user_id = auth.uid() 
    AND status = 'active'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Check if user is the business owner (ONLY checks businesses, NO recursion)
CREATE OR REPLACE FUNCTION is_business_owner(business_id_param UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM businesses 
    WHERE id = business_id_param 
    AND owner_user_id = auth.uid()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Helper for roles since businesses mapping is needed for non-recursive check
CREATE OR REPLACE FUNCTION owner_user_id_check(bid UUID) RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM businesses WHERE id = bid AND owner_user_id = auth.uid());
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. BUSINESSES TABLE
-- ============================================================================
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can manage own businesses" ON businesses
  FOR ALL USING (owner_user_id = auth.uid());

CREATE POLICY "Members can view joined businesses" ON businesses
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.business_id = businesses.id
      AND m.user_id = auth.uid()
      AND m.status = 'active'
    )
  );

-- ============================================================================
-- 4. MEMBERSHIPS TABLE
-- ============================================================================
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own memberships" ON memberships
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Owners can manage all business memberships" ON memberships
  FOR ALL USING (owner_user_id_check(business_id));

CREATE POLICY "Members can view other members" ON memberships
  FOR SELECT USING (is_business_member(business_id));

-- ============================================================================
-- 5. ROLES & PERMISSIONS
-- ============================================================================
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Roles are viewable by members" ON roles
  FOR SELECT USING (
    is_system = TRUE OR
    owner_user_id_check(business_id) OR
    is_business_member(business_id)
  );

CREATE POLICY "Owners can manage custom roles" ON roles
  FOR ALL USING (
    is_system = FALSE AND
    owner_user_id_check(business_id)
  );

CREATE POLICY "Permissions are public" ON permissions FOR SELECT USING (TRUE);
CREATE POLICY "Role permissions are public" ON role_permissions FOR SELECT USING (TRUE);

-- ============================================================================
-- 6. INVITATIONS & AUDIT LOGS
-- ============================================================================
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can manage invitations" ON invitations
  FOR ALL USING (owner_user_id_check(business_id));

CREATE POLICY "Invitees can view invitations" ON invitations
  FOR SELECT USING (email = auth.jwt()->>'email');

CREATE POLICY "Owners can manage audit logs" ON audit_logs
  FOR ALL USING (owner_user_id_check(business_id));

-- ============================================================================
-- 7. USERS TABLE (Explicit accessibility for joins)
-- ============================================================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public profile access" ON users
  FOR SELECT USING (TRUE);
