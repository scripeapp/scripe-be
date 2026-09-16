-- Add currency column to sessions table if it doesn't exist
-- Default to NGN

BEGIN;

ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'NGN';

COMMENT ON COLUMN sessions.currency IS 'Currency code for the session price (e.g. NGN, USD)';

COMMIT;
