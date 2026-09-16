-- Migration to replace campaigns_per_month with emails_per_month in plan_limits

BEGIN;

-- Update 'starter' plan to 100 emails/month
UPDATE plan_limits
SET limits = limits - 'campaigns_per_month' || jsonb_build_object('emails_per_month', 100)
WHERE plan = 'starter' AND limits ? 'campaigns_per_month';

-- Update 'plus' plan to 1000 emails/month 
UPDATE plan_limits
SET limits = limits - 'campaigns_per_month' || jsonb_build_object('emails_per_month', 1000)
WHERE plan = 'plus' AND limits ? 'campaigns_per_month';

-- Update 'pro' plan to 2000 emails/month
UPDATE plan_limits
SET limits = limits - 'campaigns_per_month' || jsonb_build_object('emails_per_month', 2000)
WHERE plan = 'pro' AND limits ? 'campaigns_per_month';

-- Handle case where it might have already been run or is fresh seed:
UPDATE plan_limits
SET limits = limits || jsonb_build_object('emails_per_month', 100)
WHERE plan = 'starter' AND NOT (limits ? 'emails_per_month') AND NOT (limits ? 'campaigns_per_month');

UPDATE plan_limits
SET limits = limits || jsonb_build_object('emails_per_month', 1000)
WHERE plan = 'plus' AND NOT (limits ? 'emails_per_month') AND NOT (limits ? 'campaigns_per_month');

UPDATE plan_limits
SET limits = limits || jsonb_build_object('emails_per_month', 2000)
WHERE plan = 'pro' AND NOT (limits ? 'emails_per_month') AND NOT (limits ? 'campaigns_per_month');

COMMIT;
