-- ============================================================================
-- Wallet ledger: deposit fees
-- ============================================================================
-- Dedicated-nuban wallet deposits credit the NET amount (gross minus Paystack
-- and Hilaq fees). `amount` keeps its balance semantics; the new columns
-- preserve the fee accounting for record-keeping and admin lookup.
-- `fee_breakdown` is stored but intentionally never rendered to users.
-- ============================================================================

BEGIN;

ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS gross_amount numeric(14, 2),
  ADD COLUMN IF NOT EXISTS fee_amount numeric(14, 2),
  ADD COLUMN IF NOT EXISTS fee_breakdown jsonb;

UPDATE wallet_transactions
SET gross_amount = amount,
    fee_amount = 0,
    fee_breakdown = '{}'::jsonb
WHERE gross_amount IS NULL;

ALTER TABLE wallet_transactions
  ALTER COLUMN gross_amount SET NOT NULL,
  ALTER COLUMN gross_amount SET DEFAULT 0,
  ALTER COLUMN fee_amount SET NOT NULL,
  ALTER COLUMN fee_amount SET DEFAULT 0,
  ALTER COLUMN fee_breakdown SET NOT NULL,
  ALTER COLUMN fee_breakdown SET DEFAULT '{}'::jsonb;

ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_gross_amount_non_negative
    CHECK (gross_amount >= 0),
  ADD CONSTRAINT wallet_transactions_fee_amount_non_negative
    CHECK (fee_amount >= 0);

COMMIT;