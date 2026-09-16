-- ============================================================================
-- Flutterwave Subaccount Support
-- ============================================================================
-- Adds flw_subaccount_id / flw_country to businesses so each business can
-- hold both a Paystack subaccount (NGN) and a Flutterwave subaccount
-- (GHS / KES / ZAR / USD / etc.)
-- The id stored here is the "id" field returned by POST /subaccounts on the
-- Flutterwave v4 API (format: RS_xxxxxxxxxxxxxxxxxxxx).
-- ============================================================================

BEGIN;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS flw_subaccount_id TEXT,
  ADD COLUMN IF NOT EXISTS flw_country       TEXT; -- ISO code used when the subaccount was created

CREATE INDEX IF NOT EXISTS idx_businesses_flw_subaccount
  ON businesses(flw_subaccount_id)
  WHERE flw_subaccount_id IS NOT NULL;

COMMENT ON COLUMN businesses.flw_subaccount_id IS
  'Flutterwave subaccount id (RS_xxx) for non-NGN split payments';
COMMENT ON COLUMN businesses.flw_country IS
  'ISO country code used when the Flutterwave subaccount was created (e.g. NG, GH, KE)';

COMMIT;
