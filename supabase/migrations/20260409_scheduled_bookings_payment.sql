-- Add payment fields to scheduled_bookings for paid event types
ALTER TABLE scheduled_bookings
  ADD COLUMN IF NOT EXISTS payment_reference TEXT NULL,
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'refunded')),
  ADD COLUMN IF NOT EXISTS payment_amount NUMERIC(10, 2) NULL,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ NULL;

-- Also add awaiting_payment to the status constraint if not already present
-- (Supabase doesn't allow ALTER CONSTRAINT easily, so we do it via a new check)
ALTER TABLE scheduled_bookings DROP CONSTRAINT IF EXISTS scheduled_bookings_status_check;
ALTER TABLE scheduled_bookings
  ADD CONSTRAINT scheduled_bookings_status_check
  CHECK (status IN ('pending', 'confirmed', 'cancelled', 'no_show', 'awaiting_payment'));

CREATE INDEX IF NOT EXISTS idx_scheduled_bookings_payment_reference ON scheduled_bookings(payment_reference) WHERE payment_reference IS NOT NULL;
