-- ============================================================
-- Seed permissions POS/registers depend on.
--
-- store.order.create and store.order.view are already referenced by
-- existing routes (POST /store/order, GET /store/inventory/*) but were
-- never actually seeded — meaning no non-owner staff member could be
-- granted manual-order or inventory access before this migration (the
-- owner-bypass in PermissionService.hasPermission is the only reason
-- those routes have ever worked). Fixed here alongside the new
-- store.register.* keys POS/shift operations need.
-- Follows the same pattern as forms.* / circle.* permission seeding.
-- ============================================================

INSERT INTO permissions (key, category, description) VALUES
  ('store.order.create', 'store', 'Create manual/POS orders'),
  ('store.order.view', 'store', 'View orders and inventory movements'),
  ('store.register.manage', 'store', 'Create and configure registers'),
  ('store.register.operate', 'store', 'Open/close register shifts and ring up POS orders')
ON CONFLICT (key) DO NOTHING;

-- Grant all four to Owner
DO $$
DECLARE
  v_role_id UUID;
  v_perm_id UUID;
BEGIN
  FOR v_role_id IN
    SELECT id FROM roles WHERE name = 'Owner'
  LOOP
    FOR v_perm_id IN
      SELECT id FROM permissions
      WHERE key IN ('store.order.create', 'store.order.view', 'store.register.manage', 'store.register.operate')
    LOOP
      INSERT INTO role_permissions (role_id, permission_id)
      VALUES (v_role_id, v_perm_id)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

-- Grant all four to Admin
DO $$
DECLARE
  v_role_id UUID;
  v_perm_id UUID;
BEGIN
  FOR v_role_id IN
    SELECT id FROM roles WHERE name = 'Admin'
  LOOP
    FOR v_perm_id IN
      SELECT id FROM permissions
      WHERE key IN ('store.order.create', 'store.order.view', 'store.register.manage', 'store.register.operate')
    LOOP
      INSERT INTO role_permissions (role_id, permission_id)
      VALUES (v_role_id, v_perm_id)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

-- Grant only store.order.create/view + store.register.operate to Member —
-- a cashier needs to ring up orders and operate their till, not configure
-- new registers (that stays Owner/Admin via store.register.manage).
DO $$
DECLARE
  v_role_id UUID;
  v_perm_id UUID;
BEGIN
  FOR v_role_id IN
    SELECT id FROM roles WHERE name = 'Member'
  LOOP
    FOR v_perm_id IN
      SELECT id FROM permissions
      WHERE key IN ('store.order.create', 'store.order.view', 'store.register.operate')
    LOOP
      INSERT INTO role_permissions (role_id, permission_id)
      VALUES (v_role_id, v_perm_id)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END $$;
