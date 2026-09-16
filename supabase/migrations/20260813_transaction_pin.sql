-- ============================================================================
-- Banking: internal transaction PIN (per business, stored on virtual_accounts)
--
-- Paystack's own transfer OTP/PIN is disabled, so money movement (sends and
-- withdrawals) is gated by a business-level PIN instead. One active virtual
-- account per business, so the PIN columns live on that row — intentionally
-- no separate table.
-- ============================================================================

BEGIN;

ALTER TABLE virtual_accounts
  ADD COLUMN IF NOT EXISTS has_pin boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pin_hash text,
  ADD COLUMN IF NOT EXISTS pin_attempts smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pin_locked_until timestamptz,
  ADD COLUMN IF NOT EXISTS pin_updated_at timestamptz;

COMMENT ON COLUMN virtual_accounts.pin_hash IS
  'scrypt(pin : salt : pepper), never plaintext. pin_attempts/pin_locked_until implement the brute-force lockout.';

COMMIT;