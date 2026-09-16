-- service_bookings updates for Service Product features

-- Drop existing constraint if it exists to allow modification
ALTER TABLE service_bookings DROP CONSTRAINT IF EXISTS service_bookings_status_check;

-- Update status check constraint to include new statuses
ALTER TABLE service_bookings 
  ADD CONSTRAINT service_bookings_status_check 
  CHECK (status IN ('pending', 'confirmed', 'declined', 'rescheduled', 'completed', 'cancelled', 'no_show'));

-- Add new columns
ALTER TABLE service_bookings ADD COLUMN IF NOT EXISTS location_type VARCHAR(50);
ALTER TABLE service_bookings ADD COLUMN IF NOT EXISTS location_details TEXT;
ALTER TABLE service_bookings ADD COLUMN IF NOT EXISTS approval_required BOOLEAN DEFAULT false;
ALTER TABLE service_bookings ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;
ALTER TABLE service_bookings ADD COLUMN IF NOT EXISTS decline_reason TEXT;
ALTER TABLE service_bookings ADD COLUMN IF NOT EXISTS rescheduled_from TEXT; -- ISO timestamp of original booking
ALTER TABLE service_bookings ADD COLUMN IF NOT EXISTS initiated_by VARCHAR(20) CHECK (initiated_by IN ('creator', 'customer'));

-- Comment on columns
COMMENT ON COLUMN service_bookings.location_type IS 'e.g., zoom, physical, phone';
COMMENT ON COLUMN service_bookings.approval_required IS 'Snapshot from product settings at time of booking';
