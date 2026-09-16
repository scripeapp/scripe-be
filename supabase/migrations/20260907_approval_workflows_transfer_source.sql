-- A Transfers-type workflow now declares which *source* of transfer it
-- gates: 'Bills' (a payment created via a bill's "Confirm payment") or
-- 'Manual' (a direct wallet send, not tied to any bill — the existing
-- Banking "Send money" flow, which has no gating wired to it at all yet).
-- Lets the default Transfers workflow ship active — bill-triggered
-- payments should be gated from day one, same as bills themselves — while
-- a manual transfer stays completely untouched by it. Bills/All-type
-- workflows leave this NULL; it's only meaningful for 'Transfers'.
ALTER TABLE approval_workflows ADD COLUMN IF NOT EXISTS transfer_source TEXT;

ALTER TABLE approval_workflows
  DROP CONSTRAINT IF EXISTS approval_workflows_transfer_source_check;
ALTER TABLE approval_workflows
  ADD CONSTRAINT approval_workflows_transfer_source_check
  CHECK (
    (type = 'Transfers' AND transfer_source IN ('Bills', 'Manual'))
    OR (type <> 'Transfers' AND transfer_source IS NULL)
  );

-- The old single "one active Transfers workflow, period" index didn't
-- account for source — replaced with two source-scoped ones, so a
-- business can (eventually) run an active Bills-sourced Transfers
-- workflow and an active Manual-sourced one side by side without
-- conflicting, while two workflows sharing the same source (or an active
-- 'All', which covers every source) still correctly conflict.
DROP INDEX IF EXISTS approval_workflows_active_transfers_idx;

CREATE UNIQUE INDEX IF NOT EXISTS approval_workflows_active_transfers_bills_idx
  ON approval_workflows (business_id)
  WHERE status = 'active' AND (type = 'All' OR (type = 'Transfers' AND transfer_source = 'Bills'));

CREATE UNIQUE INDEX IF NOT EXISTS approval_workflows_active_transfers_manual_idx
  ON approval_workflows (business_id)
  WHERE status = 'active' AND (type = 'All' OR (type = 'Transfers' AND transfer_source = 'Manual'));
