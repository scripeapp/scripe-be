-- Make subscription fields generic on public.users
-- - Add generic fields: subscription_started_at, subscription_meta
-- - Drop plan-specific flags (pro_member, pro_since)

BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS subscription_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS subscription_meta jsonb DEFAULT '{}'::jsonb;

-- Drop plan-specific columns if present
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'pro_member'
  ) THEN
    ALTER TABLE public.users DROP COLUMN pro_member;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'pro_since'
  ) THEN
    ALTER TABLE public.users DROP COLUMN pro_since;
  END IF;
END $$;

-- Comments
COMMENT ON COLUMN public.users.subscription_started_at IS 'Timestamp when the current subscription became active.';
COMMENT ON COLUMN public.users.subscription_meta IS 'Opaque JSON blob for subscription-related metadata (provider, plan_normalized, last_reference, etc.).';

COMMIT;
