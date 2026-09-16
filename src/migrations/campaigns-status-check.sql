-- Align `campaigns.status` check constraint with application statuses.
-- Safe to run multiple times.

DO $$
BEGIN
  -- If the table doesn't exist in an environment, skip.
  IF to_regclass('public.campaigns') IS NULL THEN
    RAISE NOTICE 'public.campaigns does not exist; skipping campaigns status constraint migration';
    RETURN;
  END IF;

  -- Drop the old constraint if present.
  BEGIN
    EXECUTE 'ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check';
  EXCEPTION WHEN others THEN
    -- If dropping fails for any reason, surface the error to avoid a silent partial state.
    RAISE;
  END;

  -- Recreate with expanded allowed values.
  EXECUTE $q$
    ALTER TABLE public.campaigns
    ADD CONSTRAINT campaigns_status_check
    CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'paused', 'failed', 'cancelled'))
  $q$;
END
$$;

