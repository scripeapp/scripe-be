-- Add per-event check-in access code hash to events table.
-- Ushers enter the plaintext code on the check-in page; the backend compares
-- it against this hash (SHA-256 keyed with event_id) and issues a short-lived
-- signed token. The plaintext code is never stored.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS checkin_access_code_hash TEXT;
