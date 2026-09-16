-- Migration: 20260409_booking_payment.sql
-- Description: Adds payment tracking to service_bookings and fixes the status
-- constraint to match what the application already expects.

BEGIN;

-- 1. Fix status constraint — application code uses statuses not in original constraint
ALTER TABLE service_bookings
  DROP CONSTRAINT IF EXISTS service_bookings_status_check;

ALTER TABLE service_bookings
  ADD CONSTRAINT service_bookings_status_check
  CHECK (status IN (
    'pending',      -- awaiting payment or manual approval
    'confirmed',
    'declined',
    'rescheduled',
    'completed',
    'cancelled',
    'no_show'
  ));

-- 2. Add payment tracking columns
ALTER TABLE service_bookings
  ADD COLUMN IF NOT EXISTS payment_amount    DECIMAL(10,2)  NULL,
  ADD COLUMN IF NOT EXISTS payment_reference TEXT           NULL,
  ADD COLUMN IF NOT EXISTS payment_status    TEXT           NOT NULL DEFAULT 'unpaid'
    CONSTRAINT service_bookings_payment_status_check
    CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'refunded')),
  ADD COLUMN IF NOT EXISTS paid_at           TIMESTAMPTZ    NULL;

-- 3. Backfill: existing confirmed/completed bookings came through paid store orders
UPDATE service_bookings
SET payment_status = 'paid'
WHERE status IN ('confirmed', 'completed', 'rescheduled', 'no_show')
  AND payment_status = 'unpaid';

-- 4. Index for webhook lookups by payment_reference
CREATE INDEX IF NOT EXISTS idx_service_bookings_payment_reference
  ON service_bookings (payment_reference)
  WHERE payment_reference IS NOT NULL;

COMMIT;
