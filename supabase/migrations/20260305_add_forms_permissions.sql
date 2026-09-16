-- ============================================================
-- Add 'forms.*' permissions to all team roles
-- Follows the same pattern as store.* permissions
-- ============================================================

-- Insert permissions
INSERT INTO permissions (key, category, description) VALUES
  ('forms.create', 'forms', 'Create forms'),
  ('forms.read',   'forms', 'View forms and submissions'),
  ('forms.update', 'forms', 'Edit forms'),
  ('forms.delete', 'forms', 'Delete forms')
ON CONFLICT (key) DO NOTHING;

-- Grant to owner role
DO $$
DECLARE
  v_role_id UUID;
  v_perm_id UUID;
BEGIN
  FOR v_role_id IN
    SELECT id FROM roles WHERE name = 'Owner'
  LOOP
    FOR v_perm_id IN
      SELECT id FROM permissions WHERE key LIKE 'forms.%'
    LOOP
      INSERT INTO role_permissions (role_id, permission_id)
      VALUES (v_role_id, v_perm_id)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

-- Grant to admin role
DO $$
DECLARE
  v_role_id UUID;
  v_perm_id UUID;
BEGIN
  FOR v_role_id IN
    SELECT id FROM roles WHERE name = 'Admin'
  LOOP
    FOR v_perm_id IN
      SELECT id FROM permissions WHERE key LIKE 'forms.%'
    LOOP
      INSERT INTO role_permissions (role_id, permission_id)
      VALUES (v_role_id, v_perm_id)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

-- Grant forms.read to member role
DO $$
DECLARE
  v_role_id UUID;
  v_perm_id UUID;
BEGIN
  FOR v_role_id IN
    SELECT id FROM roles WHERE name = 'Member'
  LOOP
    FOR v_perm_id IN
      SELECT id FROM permissions WHERE key = 'forms.read'
    LOOP
      INSERT INTO role_permissions (role_id, permission_id)
      VALUES (v_role_id, v_perm_id)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END $$;
