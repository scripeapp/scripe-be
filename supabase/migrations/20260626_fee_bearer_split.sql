-- ============================================================================
-- Fee Bearer: add "split" (50/50) option
-- ============================================================================
-- Extends the paystack_fee_bearer CHECK constraint on businesses and stores to
-- allow a third value, "split", where the customer and merchant each cover half
-- of the combined platform + gateway fee on a transaction.
-- ============================================================================

BEGIN;

ALTER TABLE businesses
  DROP CONSTRAINT IF EXISTS businesses_paystack_fee_bearer_check;

ALTER TABLE businesses
  ADD CONSTRAINT businesses_paystack_fee_bearer_check
  CHECK (paystack_fee_bearer IN ('subaccount', 'customer', 'split') OR paystack_fee_bearer IS NULL);

COMMENT ON COLUMN businesses.paystack_fee_bearer IS 'Who pays Paystack + platform fees: subaccount (merchant), customer, or split (50/50)';

ALTER TABLE stores
  DROP CONSTRAINT IF EXISTS stores_paystack_fee_bearer_check;

ALTER TABLE stores
  ADD CONSTRAINT stores_paystack_fee_bearer_check
  CHECK (paystack_fee_bearer IN ('subaccount', 'customer', 'split') OR paystack_fee_bearer IS NULL);

COMMENT ON COLUMN stores.paystack_fee_bearer IS 'Optional: override business fee bearer for this store (subaccount, customer, or split)';

COMMIT;
