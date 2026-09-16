-- Check-in support for scheduled bookings
ALTER TABLE scheduled_bookings
  ADD COLUMN IF NOT EXISTS check_in_time TIMESTAMPTZ;