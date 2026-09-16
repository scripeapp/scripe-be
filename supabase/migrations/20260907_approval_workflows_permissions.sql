-- Permissions for managing approval workflow configuration (Settings >
-- Approvals). Deliberately does NOT cover the approve/reject decision
-- endpoints themselves — per docs/transfers-approvals-backend-plan.md,
-- eligibility to approve/reject a specific request is a per-row, per-step
-- check done in the service layer (who's listed as an approver on that
-- step), not a blanket role permission. These two keys only gate
-- creating/editing/deleting workflow configs.
--
-- Follows 20260105_add_missing_permissions.sql's exact two-phase pattern.
-- Confirmed live: system roles are Owner, Admin, Manager, Staff, Viewer.

-- Phase 1: Insert the new permissions
INSERT INTO permissions (key, category, description) VALUES
('approvals.workflow.read', 'approvals', 'View approval workflow configuration'),
('approvals.workflow.manage', 'approvals', 'Create, edit, and delete approval workflows')
ON CONFLICT (key) DO NOTHING;

-- Phase 2: Assign to system roles
-- Owner & Admin can fully manage workflows.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name IN ('Owner', 'Admin') AND r.is_system = TRUE
AND p.key IN ('approvals.workflow.read', 'approvals.workflow.manage')
ON CONFLICT DO NOTHING;

-- Manager can see how workflows are configured, not change them.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Manager' AND r.is_system = TRUE
AND p.key = 'approvals.workflow.read'
ON CONFLICT DO NOTHING;
