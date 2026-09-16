-- Align plan limits with pricing ladder (decoy-style caps)
-- Products limits apply to FREE products only in app logic.

BEGIN;

UPDATE plan_limits
SET limits = limits
  || jsonb_build_object('products', 5)
  || jsonb_build_object('team_members', 1)
WHERE plan = 'starter';

UPDATE plan_limits
SET limits = limits
  || jsonb_build_object('products', 12)
  || jsonb_build_object('team_members', 1)
WHERE plan = 'plus';

UPDATE plan_limits
SET limits = limits
  || jsonb_build_object('products', 30)
  || jsonb_build_object('team_members', 3)
WHERE plan = 'pro';

COMMIT;
