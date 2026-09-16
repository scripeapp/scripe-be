-- Add price column to sessions table
-- Used for paid sessions

BEGIN;

ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS price DECIMAL(10,2) DEFAULT 0;

-- Optional: Add check constraint to ensure price is non-negative
ALTER TABLE sessions 
ADD CONSTRAINT sessions_price_check CHECK (price >= 0);

COMMENT ON COLUMN sessions.price IS 'Price of the session in base currency (e.g. NGN)';

COMMIT;
