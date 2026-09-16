-- Add subscription-related columns to public.users
-- Idempotent and safe to re-run

BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS subscription_plan text,
  ADD COLUMN IF NOT EXISTS subscription_status text,
  ADD COLUMN IF NOT EXISTS subscription_reference text,
  ADD COLUMN IF NOT EXISTS subscription_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS pro_member boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS pro_since timestamptz;

-- Constrain subscription_status to known lifecycle values (optional, extensible)
DO $$
BEGIN
  ALTER TABLE public.users
    ADD CONSTRAINT users_subscription_status_check
    CHECK (subscription_status IN (
      'active',
      'inactive',
      'canceled',
      'past_due',
      'trialing',
      'unpaid'
    ));
EXCEPTION
  WHEN duplicate_object THEN NULL; -- constraint already exists
END $$;

-- Helpful comments for maintainers
COMMENT ON COLUMN public.users.subscription_plan IS 'Name of the user''s subscription plan (e.g., pro, member, team, premium).';
COMMENT ON COLUMN public.users.subscription_status IS 'Lifecycle status of the subscription (active, inactive, canceled, past_due, trialing, unpaid).';
COMMENT ON COLUMN public.users.subscription_reference IS 'Latest payment/reference identifier used for idempotency and auditing.';
COMMENT ON COLUMN public.users.subscription_updated_at IS 'Timestamp when the subscription fields were last updated.';
COMMENT ON COLUMN public.users.pro_member IS 'Boolean flag indicating Pro membership.';
COMMENT ON COLUMN public.users.pro_since IS 'Timestamp when the user became Pro.';

COMMIT;