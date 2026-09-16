-- One-time email challenges for sensitive settlement-account changes.
CREATE TABLE IF NOT EXISTS settlement_account_change_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  token_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlement_verifications_lookup
  ON settlement_account_change_verifications (business_id, user_id, created_at DESC)
  WHERE consumed_at IS NULL;

COMMENT ON TABLE settlement_account_change_verifications IS
  'Short-lived, hashed email challenges required before changing settlement account details.';
