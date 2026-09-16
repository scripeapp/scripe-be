-- Final CRM Fix: Schema and Permissions
-- 20260107_fix_crm_final.sql

-- ============================================================================
-- 1. FIX SCHEMA: Add business_id to segment_activity
-- ============================================================================

-- Add the column if it doesn't exist
ALTER TABLE segment_activity 
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_segment_activity_business ON segment_activity(business_id);

-- Backfill business_id from the parent segments table
UPDATE segment_activity sa
SET business_id = s.business_id
FROM segments s
WHERE sa.segment_id = s.id
AND sa.business_id IS NULL;

-- ============================================================================
-- 2. FIX PERMISSIONS: Ensure keys and grants exist
-- ============================================================================

-- Ensure the permission key exists
INSERT INTO permissions (key, category, description)
VALUES ('crm.segment.update', 'crm', 'Edit segments')
ON CONFLICT (key) DO NOTHING;

-- Force grant to Owner role
DO $$
DECLARE
    v_role_id uuid;
    v_perm_id uuid;
BEGIN
    -- Get Owner Role ID
    SELECT id INTO v_role_id FROM roles WHERE name = 'Owner' AND is_system = TRUE LIMIT 1;
    
    -- Get Permission ID
    SELECT id INTO v_perm_id FROM permissions WHERE key = 'crm.segment.update' LIMIT 1;

    -- Insert Grant
    IF v_role_id IS NOT NULL AND v_perm_id IS NOT NULL THEN
        INSERT INTO role_permissions (role_id, permission_id) 
        VALUES (v_role_id, v_perm_id) 
        ON CONFLICT (role_id, permission_id) DO NOTHING;
        
        RAISE NOTICE 'Granted crm.segment.update to Owner role';
    ELSE
        RAISE WARNING 'Could not find Owner role or Permission key';
    END IF;
END $$;
