-- ============================================================================
-- FIX: Backfill Missing Owner Memberships
-- Ensures all businesses have their owner as a member with the Owner role
-- ============================================================================

-- Insert owner memberships for any business that doesn't have one
INSERT INTO memberships (user_id, business_id, role_id, status, joined_at)
SELECT 
    b.owner_user_id,
    b.id,
    r.id,
    'active',
    COALESCE(b.created_at, NOW())
FROM businesses b
CROSS JOIN roles r
WHERE r.name = 'Owner' 
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM memberships m 
    WHERE m.business_id = b.id 
    AND m.user_id = b.owner_user_id
  );

-- Verify: Count businesses without owner memberships (should be 0 after running)
-- SELECT COUNT(*) FROM businesses b 
-- WHERE NOT EXISTS (
--     SELECT 1 FROM memberships m 
--     WHERE m.business_id = b.id 
--     AND m.user_id = b.owner_user_id
-- );
