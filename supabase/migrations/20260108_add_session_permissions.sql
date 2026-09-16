-- ============================================================================
-- ADD SESSION PERMISSIONS
-- Adds permissions for the Session feature
-- ============================================================================

-- Phase 1: Insert new session permissions
INSERT INTO permissions (key, category, description) VALUES
-- Sessions
('session.create', 'session', 'Create sessions'),
('session.read', 'session', 'View sessions'),
('session.update', 'session', 'Edit sessions'),
('session.delete', 'session', 'Delete sessions'),
('session.member.read', 'session', 'View session members'),
('session.member.manage', 'session', 'Manage session members'),
('session.facilitator.manage', 'session', 'Manage facilitators'),
('session.occurrence.create', 'session', 'Create occurrences'),
('session.occurrence.update', 'session', 'Edit occurrences'),
('session.occurrence.delete', 'session', 'Delete occurrences')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- Phase 2: Assign permissions to system roles
-- ============================================================================

-- Owner & Admin get ALL session permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name IN ('Owner', 'Admin') AND r.is_system = TRUE
AND p.category = 'session'
ON CONFLICT DO NOTHING;

-- Manager gets all except delete and facilitator management
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Manager' AND r.is_system = TRUE
AND p.key IN (
  'session.create', 'session.read', 'session.update',
  'session.member.read', 'session.member.manage',
  'session.occurrence.create', 'session.occurrence.update'
)
ON CONFLICT DO NOTHING;

-- Staff gets read + limited occurrence management
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Staff' AND r.is_system = TRUE
AND p.key IN (
  'session.read', 'session.member.read',
  'session.occurrence.create', 'session.occurrence.update'
)
ON CONFLICT DO NOTHING;

-- Viewer gets read-only
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Viewer' AND r.is_system = TRUE
AND p.key IN ('session.read', 'session.member.read')
ON CONFLICT DO NOTHING;
