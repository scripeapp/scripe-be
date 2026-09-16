-- Add confirmation_email JSONB column to events table
-- Allows event creators to customise the post-purchase receipt email
-- Shape: { subject?: string; message?: string }
-- message is Draft.js raw JSON (same format as event_description)
-- NULL = use platform default template

ALTER TABLE events
ADD COLUMN IF NOT EXISTS confirmation_email JSONB DEFAULT NULL;

COMMENT ON COLUMN events.confirmation_email IS
  'Merchant-customised confirmation email. Shape: { subject?: string; message?: string } where message is Draft.js raw JSON. NULL uses the platform default.';
