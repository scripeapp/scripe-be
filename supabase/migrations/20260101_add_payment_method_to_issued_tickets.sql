-- Add payment_method column to issued_tickets table
-- Values: 'online' (default) | 'cash'
-- Default to 'online' for existing records and online purchases

ALTER TABLE issued_tickets 
ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'online';

-- Add comment for documentation
COMMENT ON COLUMN issued_tickets.payment_method IS 'Payment method used: online or cash. Used for auditing purposes.';
