-- ============================================================================
-- Drop store-level Paystack fee bearer override
-- ============================================================================
-- "Who pays the transaction fee" is now configured only at the business level
-- (businesses.paystack_fee_bearer). Stores always inherit the business value, so
-- the per-store override column is removed. The store subaccount/bank override
-- (stores.paystack_subaccount_code) is intentionally left in place.
-- ============================================================================

BEGIN;

ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_paystack_fee_bearer_check;
ALTER TABLE stores DROP COLUMN IF EXISTS paystack_fee_bearer;

COMMIT;
