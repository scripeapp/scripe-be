-- Registers/POS Phase 4b: device pairing. A cashier operates the till from
-- a `/pos` link that never touches the merchant dashboard — the device
-- proves it's allowed to act as a given register by presenting a long-lived
-- device token, obtained once via a short-lived pairing code the merchant
-- generates from Registers settings (mirrors how POS terminal pairing works
-- in real till systems). Only hashes are ever persisted — the plaintext
-- code/token are shown to the merchant/device exactly once.

ALTER TABLE registers
ADD COLUMN IF NOT EXISTS pairing_code_hash TEXT,
ADD COLUMN IF NOT EXISTS pairing_code_expires_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS device_token_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_registers_device_token_hash
  ON registers(device_token_hash)
  WHERE device_token_hash IS NOT NULL;

COMMENT ON COLUMN registers.pairing_code_hash IS 'SHA-256 of the current one-time pairing code (cleared once paired or expired).';
COMMENT ON COLUMN registers.device_token_hash IS 'SHA-256 of the long-lived bearer credential the paired device stores locally and sends as X-Register-Device-Token.';
