-- ============================================================================
-- Business & Store Subaccount Support
-- ============================================================================
-- Adds Paystack subaccount columns to businesses and stores tables for
-- split payment support. Enables merchants to receive payments directly.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Add subaccount columns to businesses table
-- ============================================================================

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS paystack_subaccount_code TEXT,
  ADD COLUMN IF NOT EXISTS paystack_subaccount_id INTEGER,
  ADD COLUMN IF NOT EXISTS paystack_fee_bearer TEXT DEFAULT 'subaccount';

-- Add constraint for fee_bearer values
DO $$
BEGIN
  ALTER TABLE businesses
    ADD CONSTRAINT businesses_paystack_fee_bearer_check
    CHECK (paystack_fee_bearer IN ('subaccount', 'customer') OR paystack_fee_bearer IS NULL);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Add index for subaccount lookups
CREATE INDEX IF NOT EXISTS idx_businesses_paystack_subaccount 
  ON businesses(paystack_subaccount_code) 
  WHERE paystack_subaccount_code IS NOT NULL;

-- Comments
COMMENT ON COLUMN businesses.paystack_subaccount_code IS 'Paystack subaccount code for split payments';
COMMENT ON COLUMN businesses.paystack_subaccount_id IS 'Paystack internal subaccount ID';
COMMENT ON COLUMN businesses.paystack_fee_bearer IS 'Who pays Paystack fees: subaccount (merchant) or customer';

-- ============================================================================
-- 2. Add subaccount columns to stores table (for franchise override)
-- ============================================================================

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS paystack_subaccount_code TEXT,
  ADD COLUMN IF NOT EXISTS paystack_fee_bearer TEXT;

-- Add constraint for fee_bearer values
DO $$
BEGIN
  ALTER TABLE stores
    ADD CONSTRAINT stores_paystack_fee_bearer_check
    CHECK (paystack_fee_bearer IN ('subaccount', 'customer') OR paystack_fee_bearer IS NULL);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Add index for store subaccount lookups
CREATE INDEX IF NOT EXISTS idx_stores_paystack_subaccount 
  ON stores(paystack_subaccount_code) 
  WHERE paystack_subaccount_code IS NOT NULL;

-- Comments
COMMENT ON COLUMN stores.paystack_subaccount_code IS 'Optional: Override business subaccount for this store (franchise support)';
COMMENT ON COLUMN stores.paystack_fee_bearer IS 'Optional: Override business fee bearer for this store';

-- ============================================================================
-- 3. Migrate existing user subaccounts to their businesses
-- ============================================================================

-- Copy subaccount data from owner's sub_accounts record to their businesses
-- Only updates businesses that don't already have a subaccount configured
UPDATE businesses b
SET
  paystack_subaccount_code = s.paystack_subaccount_code
FROM sub_accounts s
WHERE b.owner_user_id = s.user_id
  AND s.paystack_subaccount_code IS NOT NULL
  AND b.paystack_subaccount_code IS NULL;

-- Log how many were migrated (optional - for debugging)
DO $$
DECLARE
  migrated_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO migrated_count
  FROM businesses b
  JOIN sub_accounts s ON b.owner_user_id = s.user_id
  WHERE b.paystack_subaccount_code = s.paystack_subaccount_code;
  
  RAISE NOTICE 'Migrated % subaccounts from sub_accounts to businesses', migrated_count;
END $$;

COMMIT;
