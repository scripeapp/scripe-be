-- ============================================================================
-- Banking: withdrawal idempotency key
--
-- Client-generated key so a double-tap or retry of a withdrawal request never
-- creates a second transfer. One key per business; the same key returns the
-- already-created withdrawal instead of initiating a new one.
-- ============================================================================

BEGIN;

ALTER TABLE banking_withdrawals
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(80);

CREATE UNIQUE INDEX IF NOT EXISTS idx_banking_withdrawals_business_idempotency
  ON banking_withdrawals(business_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMIT;