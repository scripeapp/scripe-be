-- Two small follow-ups to 20260907_approval_workflows_config.sql, found
-- while writing the service layer against it (no real data yet, so both
-- are trivial additive fixes rather than backfills):
--
-- 1. approval_rule_approvers was missing `role`, present on both sibling
--    approver tables (approval_workflow_submitters, approval_group_approvers)
--    and required by the frontend's WorkflowApprover.role (non-optional) —
--    a rule's own narrower approver subset needs to round-trip the same
--    shape as a group's full approver list.
-- 2. approval_workflows needs the creator's name/email/role as a static
--    display snapshot, matching the frontend's ApprovalWorkflow type and
--    the same snapshot-not-live-join approach already used for
--    approval_requests.workflow_name. `created_by` alone (a nullable FK)
--    can't reconstruct this once a user is deleted, and doesn't cover
--    server-seeded default workflows where there's no real account action
--    to derive it from.

ALTER TABLE approval_rule_approvers ADD COLUMN IF NOT EXISTS role TEXT;

ALTER TABLE approval_workflows
  ADD COLUMN IF NOT EXISTS creator_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS creator_email TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS creator_role TEXT NOT NULL DEFAULT 'Owner';
