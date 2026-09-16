-- ============================================================================
-- Banking: Paystack Dedicated Virtual Accounts + Wallet Ledger
-- ============================================================================

BEGIN;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS paystack_customer_code varchar(100),
  ADD COLUMN IF NOT EXISTS banking_kyc_status varchar(20) NOT NULL DEFAULT 'not_started'
    CHECK (banking_kyc_status IN ('not_started', 'pending', 'verified', 'failed')),
  ADD COLUMN IF NOT EXISTS banking_kyc_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS banking_kyc_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS banking_kyc_failure_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_paystack_customer_code
  ON businesses(paystack_customer_code)
  WHERE paystack_customer_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS virtual_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider varchar(30) NOT NULL DEFAULT 'paystack',
  provider_customer_code varchar(100),
  provider_account_id varchar(100),
  account_number varchar(20),
  account_name varchar(255),
  bank_name varchar(120),
  bank_slug varchar(80),
  currency varchar(3) NOT NULL DEFAULT 'NGN',
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'failed', 'deactivated')),
  assignment_reference varchar(150),
  last_requery_at timestamptz,
  failure_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_virtual_accounts_business_id
  ON virtual_accounts(business_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_virtual_accounts_provider_account_number
  ON virtual_accounts(provider, account_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_virtual_accounts_active_business
  ON virtual_accounts(business_id)
  WHERE status IN ('pending', 'active');

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type varchar(30) NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'reversal', 'adjustment')),
  direction varchar(6) NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  status varchar(20) NOT NULL DEFAULT 'posted'
    CHECK (status IN ('pending', 'posted', 'failed', 'reversed')),
  provider varchar(30) NOT NULL DEFAULT 'paystack',
  provider_reference varchar(150) NOT NULL,
  description text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  posted_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  UNIQUE (provider, provider_reference)
);

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_business_id
  ON wallet_transactions(business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS banking_withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  requested_by uuid,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  currency varchar(3) NOT NULL DEFAULT 'NGN',
  bank_code varchar(20) NOT NULL,
  account_number varchar(20) NOT NULL,
  account_name varchar(255) NOT NULL,
  transfer_recipient_code varchar(100),
  provider_transfer_code varchar(100),
  provider_reference varchar(150),
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'success', 'failed', 'reversed')),
  failure_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_banking_withdrawals_business_id
  ON banking_withdrawals(business_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_banking_withdrawals_provider_reference
  ON banking_withdrawals(provider_reference)
  WHERE provider_reference IS NOT NULL;

ALTER TABLE virtual_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE banking_withdrawals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members access virtual_accounts" ON virtual_accounts;
CREATE POLICY "members access virtual_accounts" ON virtual_accounts
  FOR ALL USING (is_business_member(business_id))
  WITH CHECK (is_business_member(business_id));

DROP POLICY IF EXISTS "members access wallet_transactions" ON wallet_transactions;
CREATE POLICY "members access wallet_transactions" ON wallet_transactions
  FOR ALL USING (is_business_member(business_id))
  WITH CHECK (is_business_member(business_id));

DROP POLICY IF EXISTS "members access banking_withdrawals" ON banking_withdrawals;
CREATE POLICY "members access banking_withdrawals" ON banking_withdrawals
  FOR ALL USING (is_business_member(business_id))
  WITH CHECK (is_business_member(business_id));

DROP TRIGGER IF EXISTS virtual_accounts_set_updated_at ON virtual_accounts;
CREATE TRIGGER virtual_accounts_set_updated_at
  BEFORE UPDATE ON virtual_accounts
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS banking_withdrawals_set_updated_at ON banking_withdrawals;
CREATE TRIGGER banking_withdrawals_set_updated_at
  BEFORE UPDATE ON banking_withdrawals
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

COMMIT;
