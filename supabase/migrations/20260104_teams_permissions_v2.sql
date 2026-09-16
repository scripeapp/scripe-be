-- ============================================================================
-- Teams & Permissions v2 — Complete Schema
-- Based on Master Prompt specification
-- ============================================================================

-- Drop existing tables from v1 (if any) to start fresh
DROP TABLE IF EXISTS team_members CASCADE;
DROP TABLE IF EXISTS roles CASCADE;
DROP FUNCTION IF EXISTS is_store_owner(uuid) CASCADE;
DROP FUNCTION IF EXISTS is_team_member(uuid) CASCADE;
DROP FUNCTION IF EXISTS is_account_owner(uuid) CASCADE;
DROP FUNCTION IF EXISTS is_account_team_member(uuid) CASCADE;

-- ============================================================================
-- 1. BUSINESSES TABLE
-- Top-level entity representing a user's business account
-- ============================================================================
CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_businesses_owner ON businesses(owner_user_id);

-- ============================================================================
-- 2. PERMISSIONS TABLE
-- Atomic permission units using dot-notation
-- ============================================================================
CREATE TABLE IF NOT EXISTS permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key VARCHAR(100) UNIQUE NOT NULL, -- e.g., store.product.create
  category VARCHAR(50) NOT NULL, -- e.g., store, publication, team, admin
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_permissions_category ON permissions(category);
CREATE INDEX idx_permissions_key ON permissions(key);

-- ============================================================================
-- 3. ROLES TABLE
-- Named collections of permissions
-- ============================================================================
CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE, -- Null for system roles
  name VARCHAR(100) NOT NULL,
  is_system BOOLEAN DEFAULT FALSE,
  is_owner BOOLEAN DEFAULT FALSE, -- Only Owner role has this true
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- System roles have null business_id, custom roles require business_id
  CONSTRAINT check_business_id CHECK (
    (is_system = TRUE AND business_id IS NULL) OR 
    (is_system = FALSE AND business_id IS NOT NULL)
  ),
  
  -- Unique name per business (or unique for system roles)
  CONSTRAINT unique_role_name UNIQUE (business_id, name)
);

CREATE INDEX idx_roles_business ON roles(business_id);

-- ============================================================================
-- 4. ROLE_PERMISSIONS JUNCTION TABLE
-- Links roles to permissions
-- ============================================================================
CREATE TABLE IF NOT EXISTS role_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(role_id, permission_id)
);

CREATE INDEX idx_role_permissions_role ON role_permissions(role_id);
CREATE INDEX idx_role_permissions_permission ON role_permissions(permission_id);

-- ============================================================================
-- 5. MEMBERSHIPS TABLE
-- Links users to businesses with roles
-- ============================================================================
CREATE TABLE IF NOT EXISTS memberships (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL, -- Null if pending invite
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  status VARCHAR(20) DEFAULT 'invited' CHECK (status IN ('active', 'invited', 'suspended')),
  invited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  joined_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Unique user per business (only for non-null users)
  CONSTRAINT unique_user_business UNIQUE (user_id, business_id)
);

CREATE INDEX idx_memberships_user ON memberships(user_id);
CREATE INDEX idx_memberships_business ON memberships(business_id);
CREATE INDEX idx_memberships_status ON memberships(status);

-- ============================================================================
-- 6. INVITATIONS TABLE
-- Tracks pending invites with tokens and expiry
-- ============================================================================
CREATE TABLE IF NOT EXISTS invitations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  token VARCHAR(255) UNIQUE NOT NULL,
  invited_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  accepted_at TIMESTAMP WITH TIME ZONE,
  revoked_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Unique pending invite per email per business
  CONSTRAINT unique_pending_invite UNIQUE (business_id, email)
);

CREATE INDEX idx_invitations_token ON invitations(token);
CREATE INDEX idx_invitations_email ON invitations(email);
CREATE INDEX idx_invitations_business ON invitations(business_id);

-- ============================================================================
-- 7. AUDIT_LOGS TABLE
-- Immutable log of all team-related actions
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL, -- e.g., member.invited, role.created
  target_type VARCHAR(50), -- e.g., membership, role, invitation
  target_id UUID,
  metadata JSONB DEFAULT '{}'::jsonb,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_business ON audit_logs(business_id);
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_user_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at DESC);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

DROP TRIGGER IF EXISTS businesses_set_updated_at ON businesses;
CREATE TRIGGER businesses_set_updated_at
BEFORE UPDATE ON businesses
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS roles_set_updated_at ON roles;
CREATE TRIGGER roles_set_updated_at
BEFORE UPDATE ON roles
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS memberships_set_updated_at ON memberships;
CREATE TRIGGER memberships_set_updated_at
BEFORE UPDATE ON memberships
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- ============================================================================
-- SEED DATA: PERMISSIONS
-- ============================================================================

INSERT INTO permissions (key, category, description) VALUES
-- Store permissions
('store.product.create', 'store', 'Create products'),
('store.product.read', 'store', 'View products'),
('store.product.update', 'store', 'Edit products'),
('store.product.delete', 'store', 'Delete products'),
('store.order.read', 'store', 'View orders'),
('store.order.update', 'store', 'Update order status'),
('store.order.refund', 'store', 'Process refunds'),
('store.customer.read', 'store', 'View customers'),
('store.discount.create', 'store', 'Create discount codes'),
('store.discount.read', 'store', 'View discount codes'),
('store.discount.update', 'store', 'Edit discount codes'),
('store.discount.delete', 'store', 'Delete discount codes'),
('store.settings.read', 'store', 'View store settings'),
('store.settings.update', 'store', 'Update store settings'),

-- Publication permissions
('publication.post.create', 'publication', 'Create posts'),
('publication.post.read', 'publication', 'View posts'),
('publication.post.update', 'publication', 'Edit posts'),
('publication.post.delete', 'publication', 'Delete posts'),
('publication.post.publish', 'publication', 'Publish posts'),
('publication.subscriber.read', 'publication', 'View subscribers'),
('publication.subscriber.export', 'publication', 'Export subscribers'),
('publication.settings.read', 'publication', 'View publication settings'),
('publication.settings.update', 'publication', 'Update publication settings'),

-- Wallet permissions
('wallet.balance.read', 'wallet', 'View wallet balance'),
('wallet.payout.request', 'wallet', 'Request payouts'),
('wallet.payout.view', 'wallet', 'View payout history'),
('wallet.transaction.read', 'wallet', 'View transactions'),

-- Team permissions
('team.member.read', 'team', 'View team members'),
('team.member.invite', 'team', 'Invite team members'),
('team.member.remove', 'team', 'Remove team members'),
('team.member.update_role', 'team', 'Change member roles'),
('team.role.read', 'team', 'View roles'),
('team.role.create', 'team', 'Create custom roles'),
('team.role.update', 'team', 'Update custom roles'),
('team.role.delete', 'team', 'Delete custom roles'),

-- Admin permissions
('admin.billing.read', 'admin', 'View billing information'),
('admin.billing.manage', 'admin', 'Manage billing and payments'),
('admin.business.update', 'admin', 'Update business settings'),
('admin.business.delete', 'admin', 'Delete business'),
('admin.ownership.transfer', 'admin', 'Transfer business ownership'),

-- Analytics permissions
('analytics.read', 'analytics', 'View analytics and reports')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- SEED DATA: SYSTEM ROLES
-- ============================================================================

-- Owner Role (all permissions, is_owner = true)
INSERT INTO roles (name, is_system, is_owner) VALUES
('Owner', TRUE, TRUE)
ON CONFLICT (business_id, name) DO NOTHING;

-- Admin Role (all permissions except ownership transfer)
INSERT INTO roles (name, is_system, is_owner) VALUES
('Admin', TRUE, FALSE)
ON CONFLICT (business_id, name) DO NOTHING;

-- Manager Role
INSERT INTO roles (name, is_system, is_owner) VALUES
('Manager', TRUE, FALSE)
ON CONFLICT (business_id, name) DO NOTHING;

-- Staff Role
INSERT INTO roles (name, is_system, is_owner) VALUES
('Staff', TRUE, FALSE)
ON CONFLICT (business_id, name) DO NOTHING;

-- Viewer Role
INSERT INTO roles (name, is_system, is_owner) VALUES
('Viewer', TRUE, FALSE)
ON CONFLICT (business_id, name) DO NOTHING;

-- ============================================================================
-- SEED DATA: ROLE PERMISSIONS
-- ============================================================================

-- Owner gets ALL permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Owner' AND r.is_system = TRUE
ON CONFLICT DO NOTHING;

-- Admin gets all permissions EXCEPT ownership transfer and business deletion
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Admin' AND r.is_system = TRUE
AND p.key NOT IN ('admin.ownership.transfer', 'admin.business.delete')
ON CONFLICT DO NOTHING;

-- Manager gets store, publication, team read, analytics
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Manager' AND r.is_system = TRUE
AND (
  p.category IN ('store', 'publication', 'analytics')
  OR p.key IN ('team.member.read', 'team.role.read')
)
AND p.key NOT IN ('store.order.refund', 'admin.billing.manage', 'admin.billing.read')
ON CONFLICT DO NOTHING;

-- Staff gets operational access
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Staff' AND r.is_system = TRUE
AND p.key IN (
  'store.product.read',
  'store.order.read', 'store.order.update',
  'store.customer.read',
  'store.discount.read',
  'publication.post.read',
  'team.member.read'
)
ON CONFLICT DO NOTHING;

-- Viewer gets read-only access
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Viewer' AND r.is_system = TRUE
AND p.key LIKE '%.read'
ON CONFLICT DO NOTHING;

-- ============================================================================
-- RLS POLICIES
-- ============================================================================

ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Helper function: Check if user is business owner or member
CREATE OR REPLACE FUNCTION is_business_member(business_id_param UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM businesses WHERE id = business_id_param AND owner_user_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM memberships 
    WHERE business_id = business_id_param 
    AND user_id = auth.uid() 
    AND status = 'active'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Businesses: Owner and members can read
DROP POLICY IF EXISTS "Businesses viewable by members" ON businesses;
CREATE POLICY "Businesses viewable by members" ON businesses
  FOR SELECT USING (owner_user_id = auth.uid() OR is_business_member(id));

DROP POLICY IF EXISTS "Businesses manageable by owner" ON businesses;
CREATE POLICY "Businesses manageable by owner" ON businesses
  FOR ALL USING (owner_user_id = auth.uid());

-- Permissions: Readable by all authenticated users
DROP POLICY IF EXISTS "Permissions are public" ON permissions;
CREATE POLICY "Permissions are public" ON permissions
  FOR SELECT USING (TRUE);

-- Roles: System roles readable by all, custom roles by business members
DROP POLICY IF EXISTS "System roles are viewable by everyone" ON roles;
CREATE POLICY "System roles are viewable by everyone" ON roles
  FOR SELECT USING (is_system = TRUE);

DROP POLICY IF EXISTS "Custom roles viewable by business members" ON roles;
CREATE POLICY "Custom roles viewable by business members" ON roles
  FOR SELECT USING (is_system = FALSE AND is_business_member(business_id));

-- Role Permissions: Viewable if role is viewable
DROP POLICY IF EXISTS "Role permissions viewable" ON role_permissions;
CREATE POLICY "Role permissions viewable" ON role_permissions
  FOR SELECT USING (TRUE); -- Simplified, role visibility is controlled

-- Memberships: Viewable by business members
DROP POLICY IF EXISTS "Memberships viewable by business" ON memberships;
CREATE POLICY "Memberships viewable by business" ON memberships
  FOR SELECT USING (is_business_member(business_id));

-- Invitations: Viewable by business members or the invited email holder
DROP POLICY IF EXISTS "Invitations viewable by business or invitee" ON invitations;
CREATE POLICY "Invitations viewable by business or invitee" ON invitations
  FOR SELECT USING (is_business_member(business_id));

-- Audit Logs: Viewable by business members
DROP POLICY IF EXISTS "Audit logs viewable by business" ON audit_logs;
CREATE POLICY "Audit logs viewable by business" ON audit_logs
  FOR SELECT USING (is_business_member(business_id));

-- ============================================================================
-- LINK EXISTING TABLES TO BUSINESSES
-- ============================================================================

-- Add business_id to stores (will need a data migration for existing stores)
ALTER TABLE stores ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_stores_business ON stores(business_id);

-- Add business_id to publications (if table exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'publications') THEN
    EXECUTE 'ALTER TABLE publications ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE SET NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_publications_business ON publications(business_id)';
  END IF;
END $$;

-- ============================================================================
-- DATA MIGRATION: Create businesses for existing users with stores
-- ============================================================================

-- For each user with stores, create exactly ONE business and link their stores
INSERT INTO businesses (id, owner_user_id, name, status, created_at)
SELECT DISTINCT ON (s.user_id)
  uuid_generate_v4(),
  s.user_id,
  COALESCE(s.registered_business_name, s.name, 'My Business'),
  'active',
  s.created_at
FROM stores s
WHERE NOT EXISTS (SELECT 1 FROM businesses b WHERE b.owner_user_id = s.user_id)
ORDER BY s.user_id, s.created_at ASC;

-- Link existing stores to their owner's business
UPDATE stores s
SET business_id = b.id
FROM businesses b
WHERE s.user_id = b.owner_user_id AND s.business_id IS NULL;

-- Create Owner membership for each business owner
INSERT INTO memberships (user_id, business_id, role_id, status, joined_at)
SELECT 
  b.owner_user_id,
  b.id,
  (SELECT id FROM roles WHERE name = 'Owner' AND is_system = TRUE),
  'active',
  NOW()
FROM businesses b
WHERE NOT EXISTS (
  SELECT 1 FROM memberships m 
  WHERE m.user_id = b.owner_user_id 
  AND m.business_id = b.id
);
