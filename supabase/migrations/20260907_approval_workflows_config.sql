-- Approval workflows foundation (Settings > Approvals), config tables only.
-- Backs real, persisted multi-tier, multi-approver sign-off workflows for
-- both Bills and Transfers (previously frontend-only, useApprovalsStore ->
-- localStorage). See docs/transfers-approvals-backend-plan.md — this
-- migration implements that doc's "3 new migrations" step 1, widened to
-- also cover Bills (the doc predates Bills having a real backend).
--
-- Runtime approval requests and permission seeds are separate migrations
-- that follow this one.

CREATE TABLE IF NOT EXISTS approval_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('Bills', 'Transfers', 'All')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  trigger_title TEXT,
  trigger_subtitle TEXT,
  no_self_approval BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An active workflow's coverage must never overlap another active
-- workflow's coverage, or both would silently apply to the same
-- bill/transfer at once. 'All' covers both Bills and Transfers, so it
-- conflicts with an active workflow of either specific type (and with a
-- second active 'All'). Two partial unique indexes express both halves of
-- that exclusivity; a single index can't express "conflicts with either of
-- two different type-sets" on its own.
CREATE UNIQUE INDEX IF NOT EXISTS approval_workflows_active_bills_idx
  ON approval_workflows (business_id)
  WHERE status = 'active' AND type IN ('Bills', 'All');
CREATE UNIQUE INDEX IF NOT EXISTS approval_workflows_active_transfers_idx
  ON approval_workflows (business_id)
  WHERE status = 'active' AND type IN ('Transfers', 'All');

-- Empty (no rows for a workflow) means "anyone with payment access" may
-- submit into it — matches the frontend's existing "specific people" vs.
-- "anyone" toggle.
CREATE TABLE IF NOT EXISTS approval_workflow_submitters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL REFERENCES approval_workflows(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  email TEXT,
  name TEXT NOT NULL,
  role TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sequential steps in a workflow's approval chain (the builder's flowchart).
CREATE TABLE IF NOT EXISTS approval_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL REFERENCES approval_workflows(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  subtitle TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A group's full approver roster — used directly when a rule doesn't name
-- its own narrower approver subset.
CREATE TABLE IF NOT EXISTS approval_group_approvers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES approval_groups(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  email TEXT,
  name TEXT NOT NULL,
  role TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Amount-tier rules within a group, e.g. "Over ₦1,000,000 needs Owner and
-- Finance". A rule with both bounds NULL is a catch-all ("Everything
-- else") and always matches as the fallback when no narrower rule applies.
CREATE TABLE IF NOT EXISTS approval_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES approval_groups(id) ON DELETE CASCADE,
  range_label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  min_amount NUMERIC(14,2),
  max_amount NUMERIC(14,2),
  require_all BOOLEAN NOT NULL DEFAULT true,
  sequential BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT approval_rules_amount_range_check CHECK (
    min_amount IS NULL OR max_amount IS NULL OR min_amount <= max_amount
  )
);

-- A rule's own narrower approver subset (position matters only when the
-- rule is sequential). Empty means "use the group's full approver list".
CREATE TABLE IF NOT EXISTS approval_rule_approvers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  rule_id UUID NOT NULL REFERENCES approval_rules(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  email TEXT,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS approval_workflows_business_idx ON approval_workflows (business_id);
CREATE INDEX IF NOT EXISTS approval_workflow_submitters_workflow_idx ON approval_workflow_submitters (workflow_id);
CREATE INDEX IF NOT EXISTS approval_groups_workflow_idx ON approval_groups (workflow_id, position);
CREATE INDEX IF NOT EXISTS approval_group_approvers_group_idx ON approval_group_approvers (group_id);
CREATE INDEX IF NOT EXISTS approval_rules_group_idx ON approval_rules (group_id);
CREATE INDEX IF NOT EXISTS approval_rule_approvers_rule_idx ON approval_rule_approvers (rule_id, position);

ALTER TABLE approval_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_workflow_submitters ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_group_approvers ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_rule_approvers ENABLE ROW LEVEL SECURITY;

-- Every child table carries its own denormalized business_id (rather than
-- only a FK chain up to approval_workflows) so RLS can use the same direct
-- is_business_member(business_id) policy shape as the rest of this
-- codebase, instead of a correlated subquery per table.
CREATE POLICY approval_workflows_business_access ON approval_workflows
  FOR ALL USING (is_business_member(business_id)) WITH CHECK (is_business_member(business_id));
CREATE POLICY approval_workflow_submitters_business_access ON approval_workflow_submitters
  FOR ALL USING (is_business_member(business_id)) WITH CHECK (is_business_member(business_id));
CREATE POLICY approval_groups_business_access ON approval_groups
  FOR ALL USING (is_business_member(business_id)) WITH CHECK (is_business_member(business_id));
CREATE POLICY approval_group_approvers_business_access ON approval_group_approvers
  FOR ALL USING (is_business_member(business_id)) WITH CHECK (is_business_member(business_id));
CREATE POLICY approval_rules_business_access ON approval_rules
  FOR ALL USING (is_business_member(business_id)) WITH CHECK (is_business_member(business_id));
CREATE POLICY approval_rule_approvers_business_access ON approval_rule_approvers
  FOR ALL USING (is_business_member(business_id)) WITH CHECK (is_business_member(business_id));

-- set_updated_at() already exists (20260105_admin_backoffice_schema.sql).
DROP TRIGGER IF EXISTS approval_workflows_set_updated_at ON approval_workflows;
CREATE TRIGGER approval_workflows_set_updated_at
BEFORE UPDATE ON approval_workflows
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS approval_groups_set_updated_at ON approval_groups;
CREATE TRIGGER approval_groups_set_updated_at
BEFORE UPDATE ON approval_groups
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS approval_rules_set_updated_at ON approval_rules;
CREATE TRIGGER approval_rules_set_updated_at
BEFORE UPDATE ON approval_rules
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Drives lazy, idempotent default-workflow seeding server-side (a business's
-- first two default workflows — Bills and Transfers, sole approver the
-- creator — are seeded exactly once): mirrors the frontend's existing
-- "seed once, deleting it never brings it back" behavior.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS approval_workflows_seeded_at TIMESTAMPTZ;
