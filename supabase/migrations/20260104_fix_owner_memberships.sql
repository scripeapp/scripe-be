-- Fix Missing Owner Memberships
-- Run this to create Owner memberships for existing businesses that don't have them

-- Step 1: Get the Owner role ID
DO $$
DECLARE
  owner_role_id UUID;
BEGIN
  -- Get the Owner system role ID
  SELECT id INTO owner_role_id FROM roles WHERE name = 'Owner' AND is_system = TRUE;
  
  IF owner_role_id IS NULL THEN
    RAISE EXCEPTION 'Owner role not found! Please run the main migration first.';
  END IF;

  RAISE NOTICE 'Owner role ID: %', owner_role_id;

  -- Step 2: Insert missing owner memberships
  INSERT INTO memberships (user_id, business_id, role_id, status, joined_at)
  SELECT 
    b.owner_user_id,
    b.id,
    owner_role_id,
    'active',
    COALESCE(b.created_at, NOW())
  FROM businesses b
  WHERE NOT EXISTS (
    SELECT 1 FROM memberships m 
    WHERE m.business_id = b.id 
    AND m.user_id = b.owner_user_id
  );

  RAISE NOTICE 'Owner memberships created for all businesses.';
END $$;

-- Verify: Show all businesses and their owner memberships
SELECT 
  b.id AS business_id,
  b.name AS business_name,
  b.owner_user_id,
  m.id AS membership_id,
  r.name AS role_name,
  m.status AS membership_status
FROM businesses b
LEFT JOIN memberships m ON m.business_id = b.id AND m.user_id = b.owner_user_id
LEFT JOIN roles r ON r.id = m.role_id
ORDER BY b.created_at DESC;
