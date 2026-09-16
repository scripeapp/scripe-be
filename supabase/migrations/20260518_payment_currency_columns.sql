-- Add payment_currency to tables that route through the payment factory
-- Default 'NGN' preserves all existing behaviour; update per-record when a non-NGN currency is needed.

ALTER TABLE circles
  ADD COLUMN IF NOT EXISTS payment_currency TEXT DEFAULT 'NGN';

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS payment_currency TEXT DEFAULT 'NGN';

ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS payment_currency TEXT DEFAULT 'NGN';

ALTER TABLE event_types
  ADD COLUMN IF NOT EXISTS payment_currency TEXT DEFAULT 'NGN';

-- Confirm exact table name for booking products before running:
-- ALTER TABLE booking_products ADD COLUMN IF NOT EXISTS payment_currency TEXT DEFAULT 'NGN';
