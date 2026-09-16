-- Migration: 2026-08-17
-- Persist the full checkout payload at initiate time so payments whose metadata
-- Paystack strips (per-order virtual-account bank transfers arrive at the
-- webhook with only {referrer}) can be fulfilled automatically.
--
-- The reference is the immutable join key: it is present in every webhook /
-- verification payload regardless of channel. Each initiate attempt owns its
-- own row (references are unique per attempt).
--
-- Status lifecycle:
--   pending   → row created at initiate, awaiting payment
--   fulfilled → order created for the reference (webhook fallback marks it)
--   abandoned → expires_at passed and no order exists (daily cron)

CREATE TABLE IF NOT EXISTS pending_checkouts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference      text NOT NULL UNIQUE,
  payment_type   text NOT NULL,
  amount_kobo    integer NOT NULL,
  customer_email text NOT NULL,
  subaccount_code text,
  metadata       jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'pending',
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '14 days'
);

CREATE INDEX IF NOT EXISTS pending_checkouts_reference_idx
  ON pending_checkouts (reference);

CREATE INDEX IF NOT EXISTS pending_checkouts_status_idx
  ON pending_checkouts (status);