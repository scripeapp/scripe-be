-- Force grant ALL permissions to the Owner role
-- This acts as a self-healing step for any missing permissions
-- 20260106_force_grant_owner_permissions.sql

DO $$
DECLARE
    owner_role_id UUID;
BEGIN
    -- Get system Owner role ID
    SELECT id INTO owner_role_id FROM roles WHERE name = 'Owner' AND is_system = TRUE LIMIT 1;

    IF owner_role_id IS NOT NULL THEN
        -- Insert ALL permissions for this role
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT owner_role_id, p.id 
        FROM permissions p
        ON CONFLICT (role_id, permission_id) DO NOTHING;
        
        RAISE NOTICE 'Granted all permissions to Owner role (ID: %)', owner_role_id;
    ELSE
        RAISE WARNING 'System Owner role not found!';
    END IF;
END $$;
