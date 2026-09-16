-- ============================================================
-- Cohort Monetization: enrollment payments, outcomes, alumni
-- ============================================================

-- 1. Extend circle_cohorts with payment + enrollment window fields
ALTER TABLE circle_cohorts
  ADD COLUMN IF NOT EXISTS price                NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency             TEXT NOT NULL DEFAULT 'NGN',
  ADD COLUMN IF NOT EXISTS payment_mode         TEXT NOT NULL DEFAULT 'full'
    CHECK (payment_mode IN ('full', 'split')),
  ADD COLUMN IF NOT EXISTS enrollment_opens_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS enrollment_closes_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS whatsapp_invite_url  TEXT,
  ADD COLUMN IF NOT EXISTS is_published         BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Add payment tracking to circle_cohort_enrollments
ALTER TABLE circle_cohort_enrollments
  ADD COLUMN IF NOT EXISTS payment_reference  TEXT,
  ADD COLUMN IF NOT EXISTS payment_status     TEXT NOT NULL DEFAULT 'free'
    CHECK (payment_status IN ('free', 'pending', 'paid', 'split_partial')),
  ADD COLUMN IF NOT EXISTS amount_paid        NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS split_due_date     DATE;

-- 3. Extend circle_members role enum to include alumni
ALTER TABLE circle_members
  DROP CONSTRAINT IF EXISTS circle_members_role_check;

ALTER TABLE circle_members
  ADD CONSTRAINT circle_members_role_check
    CHECK (role IN ('audience', 'facilitator', 'alumni'));

-- 4. Outcome capture table
CREATE TABLE IF NOT EXISTS circle_cohort_outcomes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id    UUID NOT NULL REFERENCES circle_cohorts(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  week_num     INT NOT NULL,
  outcome_text TEXT,
  rating       INT CHECK (rating BETWEEN 1 AND 5),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cohort_id, user_id, week_num)
);

-- Index for fast per-cohort outcome lookups
CREATE INDEX IF NOT EXISTS idx_cohort_outcomes_cohort_id
  ON circle_cohort_outcomes (cohort_id);
