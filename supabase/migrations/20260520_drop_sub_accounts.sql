-- ============================================================================
-- Drop sub_accounts table
-- ============================================================================
-- Personal subaccounts are no longer supported. Subaccount management is
-- exclusively through the businesses table (paystack_subaccount_code,
-- flw_subaccount_id). All backend reads from sub_accounts have been removed.
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS sub_accounts CASCADE;

COMMIT;
