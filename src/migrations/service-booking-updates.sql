-- ============================================================================
-- Service Booking Management Updates - Migration
-- Run this in Supabase SQL Editor
-- ============================================================================

-- 1. Add new columns to service_bookings table
-- ============================================================================

-- Decline reason (for when a booking is declined)
ALTER TABLE service_bookings 
ADD COLUMN IF NOT EXISTS decline_reason TEXT;

-- Track the original datetime when rescheduling
ALTER TABLE service_bookings 
ADD COLUMN IF NOT EXISTS rescheduled_from TIMESTAMP;

-- Track who initiated the action (creator or customer)
ALTER TABLE service_bookings 
ADD COLUMN IF NOT EXISTS initiated_by VARCHAR(20);

-- 2. Expand status column to support new statuses
-- ============================================================================
-- Valid values: pending, confirmed, declined, rescheduled, completed, cancelled, no_show

-- If status is an ENUM, you may need to add new values:
-- ALTER TYPE booking_status ADD VALUE 'pending';
-- ALTER TYPE booking_status ADD VALUE 'declined';
-- ALTER TYPE booking_status ADD VALUE 'rescheduled';

-- If status is VARCHAR, it should already support the new values.

-- 3. Add new columns to products table (for service products)
-- ============================================================================

-- Location type for service (e.g., 'zoom', 'in_person', 'phone')
ALTER TABLE products 
ADD COLUMN IF NOT EXISTS service_location_type VARCHAR(50);

-- Whether the service requires approval before confirmation
ALTER TABLE products 
ADD COLUMN IF NOT EXISTS service_requires_approval BOOLEAN DEFAULT false;

-- ============================================================================
-- Verification Query
-- Run this to verify the columns were added:
-- ============================================================================

-- SELECT column_name, data_type 
-- FROM information_schema.columns 
-- WHERE table_name = 'service_bookings' 
--   AND column_name IN ('decline_reason', 'rescheduled_from', 'initiated_by');

-- SELECT column_name, data_type 
-- FROM information_schema.columns 
-- WHERE table_name = 'products' 
--   AND column_name IN ('service_location_type', 'service_requires_approval');
