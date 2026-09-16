-- ============================================================================
-- Subaccount Settlement Schedule
-- ============================================================================
-- Lets merchants control how often Paystack settles their subaccount balance.
-- "manual" holds funds until the merchant requests a payout.
-- ============================================================================

BEGIN;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS paystack_settlement_schedule TEXT DEFAULT 'auto';

DO $$
BEGIN
  ALTER TABLE businesses
    ADD CONSTRAINT businesses_paystack_settlement_schedule_check
    CHECK (
      paystack_settlement_schedule IN ('auto', 'weekly', 'monthly', 'manual')
      OR paystack_settlement_schedule IS NULL
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN businesses.paystack_settlement_schedule IS
  'Paystack subaccount settlement schedule: auto (T+1), weekly, monthly, or manual (payout on request)';

COMMIT;
