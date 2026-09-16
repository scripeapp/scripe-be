-- Set Pro plan CRM contacts visibility limit to unlimited

BEGIN;

UPDATE plan_limits
SET limits = limits || jsonb_build_object('crm_contacts', 'unlimited')
WHERE plan = 'pro';

COMMIT;
