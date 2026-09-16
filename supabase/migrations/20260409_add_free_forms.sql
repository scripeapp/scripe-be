-- Migration: 20260409_add_free_forms.sql
-- Description: Allows forms to be free (no payment required).
-- Adds access_type to hilaq_forms and relaxes payment_reference constraint
-- on form_submissions so free submissions can be stored directly.

BEGIN;

-- 1. Add access_type to hilaq_forms
ALTER TABLE hilaq_forms
  ADD COLUMN IF NOT EXISTS access_type TEXT NOT NULL DEFAULT 'paid'
    CONSTRAINT hilaq_forms_access_type_check CHECK (access_type IN ('free', 'paid'));

-- 2. Make payment_reference nullable (free submissions have no reference)
ALTER TABLE form_submissions
  ALTER COLUMN payment_reference DROP NOT NULL;

-- 3. Add 'submitted' status for free form submissions
ALTER TABLE form_submissions
  DROP CONSTRAINT IF EXISTS form_submissions_status_check;

ALTER TABLE form_submissions
  ADD CONSTRAINT form_submissions_status_check
  CHECK (status IN ('paid', 'submitted', 'refunded'));

-- 4. Allow anon inserts for free form submissions (service role already allowed)
CREATE POLICY IF NOT EXISTS "FormSubmissions: anon can insert free submissions"
  ON form_submissions FOR INSERT
  TO anon
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM hilaq_forms f
      WHERE f.id = form_submissions.form_id
        AND f.access_type = 'free'
        AND f.is_published = TRUE
        AND f.deleted_at IS NULL
    )
  );

COMMIT;
