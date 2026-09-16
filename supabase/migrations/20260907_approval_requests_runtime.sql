-- Approval requests: the runtime table backing an in-flight sign-off. One
-- row per bill/transfer that a workflow has gated. See
-- docs/transfers-approvals-backend-plan.md's "transfer_approval_requests"
-- design — generalized here into a single polymorphic table (subject_type +
-- subject_id) rather than one hard-wired to banking_withdrawals, so Bills
-- approval and Transfers approval share one engine, one set of
-- concurrency-safety guarantees, and one approver-facing UI instead of
-- duplicating all three per subject kind.
--
-- subject_type/subject_id intentionally has no FK — it can point at a
-- supplier_bills row, a banking_withdrawals row, or (once that table
-- exists) a bill_transfers row. RLS + business_id scoping keep this safe
-- without needing a real foreign key across three different possible
-- target tables.

CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('bill', 'withdrawal', 'bill_transfer')),
  subject_id UUID NOT NULL,
  -- Snapshot, not a live join: freezes the policy exactly as it existed
  -- when the request was created, immune to later edits to the workflow
  -- config. workflow_id is nullable (ON DELETE SET NULL) so history
  -- survives the workflow itself being deleted later; workflow_name is
  -- kept alongside for display once that happens.
  workflow_id UUID REFERENCES approval_workflows(id) ON DELETE SET NULL,
  workflow_name TEXT NOT NULL,
  requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  -- One entry per group, each shaped like:
  -- {groupId, title, position, requireAll, sequential, status,
  --  approvers:[{userId,email,name,position,decision,decidedAt}]}
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Denormalized from steps for cheap "what's pending for me" lookups
  -- without unpacking JSONB on every request.
  pending_approver_ids UUID[] NOT NULL DEFAULT '{}',
  -- Optimistic concurrency: every decision write does a compare-and-swap
  -- UPDATE ... WHERE id = X AND version = expected, so two concurrent
  -- "any-one" approvers acting on the same step can't both win.
  version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id)
);

CREATE INDEX IF NOT EXISTS approval_requests_business_status_idx ON approval_requests (business_id, status);
CREATE INDEX IF NOT EXISTS approval_requests_pending_approvers_idx
  ON approval_requests USING GIN (pending_approver_ids)
  WHERE status = 'pending';

ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY approval_requests_business_access ON approval_requests
  FOR ALL USING (is_business_member(business_id)) WITH CHECK (is_business_member(business_id));

DROP TRIGGER IF EXISTS approval_requests_set_updated_at ON approval_requests;
CREATE TRIGGER approval_requests_set_updated_at
BEFORE UPDATE ON approval_requests
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A gated withdrawal sits here before any Paystack call is made; a
-- rejected one never gets one at all. Both are new terminal/interim states
-- this feature introduces.
ALTER TABLE banking_withdrawals
  DROP CONSTRAINT IF EXISTS banking_withdrawals_status_check;
ALTER TABLE banking_withdrawals
  ADD CONSTRAINT banking_withdrawals_status_check
  CHECK (status IN ('pending', 'awaiting_approval', 'processing', 'success', 'failed', 'reversed', 'rejected'));

-- supplier_bills already has a 'pending' status meaning "awaiting
-- approval" and a 'rejected' status from the earlier bills-dashboard
-- migration — both already cover what a gated bill needs, so no change
-- required there.
