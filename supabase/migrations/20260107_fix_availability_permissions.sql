-- Fix Availability Permissions and Schema
-- 20260107_fix_availability_permissions.sql

-- 1. Insert Missing Permissions
INSERT INTO permissions (key, category, description) VALUES
('availability.read', 'availability', 'View availability profiles'),
('availability.create', 'availability', 'Create availability profiles'),
('availability.update', 'availability', 'Update availability profiles'),
('availability.delete', 'availability', 'Delete availability profiles')
ON CONFLICT (key) DO NOTHING;

-- 2. Grant Permissions to Owner Role (System Role)
DO $$
DECLARE
    v_role_id uuid;
BEGIN
    SELECT id INTO v_role_id FROM roles WHERE name = 'Owner' AND is_system = TRUE LIMIT 1;
    
    IF v_role_id IS NOT NULL THEN
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT v_role_id, id FROM permissions WHERE category = 'availability'
        ON CONFLICT DO NOTHING;
    END IF;
END $$;

-- 3. Grant Read/Update to Admin and Manager as well
DO $$
DECLARE
    v_admin_role uuid;
    v_manager_role uuid;
BEGIN
    SELECT id INTO v_admin_role FROM roles WHERE name = 'Admin' AND is_system = TRUE LIMIT 1;
    SELECT id INTO v_manager_role FROM roles WHERE name = 'Manager' AND is_system = TRUE LIMIT 1;
    
    -- Grant all to Admin
    IF v_admin_role IS NOT NULL THEN
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT v_admin_role, id FROM permissions WHERE category = 'availability'
        ON CONFLICT DO NOTHING;
    END IF;

    -- Grant Read to Manager
    IF v_manager_role IS NOT NULL THEN
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT v_manager_role, id FROM permissions WHERE key = 'availability.read'
        ON CONFLICT DO NOTHING;
    END IF;
END $$;

-- 4. Schema Fix: Make owner_id nullable (as we now rely on business_id)
ALTER TABLE availability_profiles ALTER COLUMN owner_id DROP NOT NULL;
