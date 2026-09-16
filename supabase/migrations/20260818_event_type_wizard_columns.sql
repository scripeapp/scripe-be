-- Event type wizard: confirmation & reminders + attendee contact field modes.
-- Backed by the 4-step creation flow (Details → Availability → Booking form → Confirmation and reminders).

ALTER TABLE event_types
  ADD COLUMN IF NOT EXISTS confirmation_message   TEXT,
  ADD COLUMN IF NOT EXISTS email_reminder_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS sms_reminder_minutes   INTEGER,
  ADD COLUMN IF NOT EXISTS redirect_link          TEXT,
  ADD COLUMN IF NOT EXISTS attendee_name_mode     TEXT NOT NULL DEFAULT 'required',
  ADD COLUMN IF NOT EXISTS attendee_email_mode    TEXT NOT NULL DEFAULT 'required',
  ADD COLUMN IF NOT EXISTS attendee_phone_mode    TEXT NOT NULL DEFAULT 'hidden';