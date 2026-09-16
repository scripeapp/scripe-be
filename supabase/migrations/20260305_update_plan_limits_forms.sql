-- ============================================================
-- Update plan_limits to add 'forms' resource (unlimited all)
-- All plans get unlimited forms (no gating).
-- This updates the JSONB limits and features columns.
-- ============================================================

UPDATE plan_limits
SET
  limits = limits || '{"forms": "unlimited"}'::jsonb,
  features = features || '{"forms": true}'::jsonb;
