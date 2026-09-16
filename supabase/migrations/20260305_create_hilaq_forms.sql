-- ============================================================
-- Hilaq Forms Feature
-- Creates hilaq_forms and form_submissions tables
-- All forms require payment; submission record is created
-- only after payment is confirmed via webhook.
-- ============================================================

-- Enable UUID extension (idempotent)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- hilaq_forms: one row per form created by an organizer
CREATE TABLE IF NOT EXISTS hilaq_forms (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  slug TEXT UNIQUE NOT NULL,

  -- Published flag
  is_published BOOLEAN DEFAULT FALSE,

  -- Payment settings (all forms are paid-only)
  payment_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  payment_currency VARCHAR(3) DEFAULT 'NGN',
  payment_label TEXT DEFAULT 'Registration Fee',

  -- Subaccount override (inherits from business if null)
  paystack_subaccount_code TEXT,

  -- Ordered list of field definitions (JSONB)
  -- Each field: { id, type, label, placeholder, required, options[] }
  fields JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Post-submission settings
  settings JSONB DEFAULT '{
    "confirmation_message": "Thank you! Your payment has been confirmed.",
    "redirect_url": null
  }'::jsonb,

  -- Cached counters (maintained by triggers / webhook)
  submissions_count INTEGER DEFAULT 0,
  paid_submissions_count INTEGER DEFAULT 0,

  -- Soft delete
  deleted_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- form_submissions: created ONLY after webhook confirms payment
CREATE TABLE IF NOT EXISTS form_submissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  form_id UUID NOT NULL REFERENCES hilaq_forms(id) ON DELETE CASCADE,

  -- Submitted field data (key = field id, value = answer)
  data JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Payment confirmation
  status TEXT DEFAULT 'paid' CHECK (status IN ('paid', 'refunded')),
  payment_reference TEXT NOT NULL,
  payment_amount DECIMAL(10, 2),
  payment_currency VARCHAR(3) DEFAULT 'NGN',

  -- Submitter info (extracted from form data / Paystack)
  submitter_email TEXT,
  submitter_name TEXT,

  paid_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_hilaq_forms_business_id ON hilaq_forms(business_id);
CREATE INDEX IF NOT EXISTS idx_hilaq_forms_slug ON hilaq_forms(slug);
CREATE INDEX IF NOT EXISTS idx_hilaq_forms_deleted_at ON hilaq_forms(deleted_at);
CREATE INDEX IF NOT EXISTS idx_form_submissions_form_id ON form_submissions(form_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_payment_reference ON form_submissions(payment_reference);

-- ============================================================
-- Triggers: auto-update updated_at
-- ============================================================
DROP TRIGGER IF EXISTS hilaq_forms_set_updated_at ON hilaq_forms;
CREATE TRIGGER hilaq_forms_set_updated_at
  BEFORE UPDATE ON hilaq_forms
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- ============================================================
-- Row Level Security
-- ============================================================

ALTER TABLE hilaq_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_submissions ENABLE ROW LEVEL SECURITY;

-- hilaq_forms: business members can manage their forms
CREATE POLICY "Forms: business members can select"
  ON hilaq_forms FOR SELECT
  USING (is_business_member(business_id));

CREATE POLICY "Forms: business members can insert"
  ON hilaq_forms FOR INSERT
  WITH CHECK (is_business_member(business_id));

CREATE POLICY "Forms: business members can update"
  ON hilaq_forms FOR UPDATE
  USING (is_business_member(business_id));

CREATE POLICY "Forms: business members can delete"
  ON hilaq_forms FOR DELETE
  USING (is_business_member(business_id));

-- Public read: only published, non-deleted forms
CREATE POLICY "Forms: public can read published forms"
  ON hilaq_forms FOR SELECT
  TO anon
  USING (is_published = TRUE AND deleted_at IS NULL);

-- form_submissions: business members can manage their submissions
CREATE POLICY "FormSubmissions: business members can select"
  ON form_submissions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM hilaq_forms f
      WHERE f.id = form_submissions.form_id
        AND is_business_member(f.business_id)
    )
  );

-- Service role inserts submissions (webhook uses service role)
CREATE POLICY "FormSubmissions: service role can insert"
  ON form_submissions FOR INSERT
  TO service_role
  WITH CHECK (TRUE);

-- ============================================================
-- Counter trigger: increment paid_submissions_count on insert
-- ============================================================
CREATE OR REPLACE FUNCTION increment_form_submission_count()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE hilaq_forms
  SET
    submissions_count = submissions_count + 1,
    paid_submissions_count = paid_submissions_count + 1,
    updated_at = NOW()
  WHERE id = NEW.form_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_increment_form_submission_count ON form_submissions;
CREATE TRIGGER trg_increment_form_submission_count
  AFTER INSERT ON form_submissions
  FOR EACH ROW EXECUTE FUNCTION increment_form_submission_count();
