-- NDPR compliance: record explicit consent at signup.
-- consent_version ties each user to the exact policy version they agreed to,
-- so future policy changes can identify users who need to re-consent.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS consent_given   BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS consent_date    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consent_ip      TEXT,
  ADD COLUMN IF NOT EXISTS consent_version TEXT;

-- Backfill users who signed up before this column existed.
-- We treat prior usage as implicit consent and record the policy version
-- that was live at the time of this migration.
UPDATE public.users
  SET consent_given   = TRUE,
      consent_date    = created_at,
      consent_version = 'pre-ndpr-2026'
  WHERE consent_given = FALSE;
