-- Add payment fields to event_types for paid scheduling
ALTER TABLE event_types
  ADD COLUMN IF NOT EXISTS requires_payment BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payment_amount NUMERIC(10, 2) NULL,
  ADD COLUMN IF NOT EXISTS payment_label TEXT NOT NULL DEFAULT 'Consultation Fee';
