-- ============================================================================
-- PARTNER REFERRAL PROGRAM
-- Admin-managed partners with referral codes, downline tracking, and commissions
-- ============================================================================

-- Partners (admin-activated accounts)
CREATE TABLE IF NOT EXISTS partners (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  code VARCHAR(12) NOT NULL UNIQUE,
  commission_type VARCHAR(10) DEFAULT 'percentage' CHECK (commission_type IN ('percentage', 'flat')),
  commission_value DECIMAL(10,2) NOT NULL DEFAULT 10.00,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'inactive')),
  total_earnings DECIMAL(12,2) DEFAULT 0,
  total_referrals INT DEFAULT 0,
  clicks INT DEFAULT 0,
  notes TEXT,
  activated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Referred users (downline)
CREATE TABLE IF NOT EXISTS partner_referrals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  referred_user_id UUID REFERENCES auth.users(id),
  referred_email VARCHAR(255),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'signed_up', 'active')),
  signed_up_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Commission ledger (per-transaction commissions)
CREATE TABLE IF NOT EXISTS partner_commissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  referral_id UUID NOT NULL REFERENCES partner_referrals(id),
  transaction_type VARCHAR(30) NOT NULL,
  transaction_id UUID,
  transaction_amount DECIMAL(12,2) NOT NULL,
  commission_amount DECIMAL(12,2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'NGN',
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'rejected')),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pr_partner ON partner_referrals(partner_id);
CREATE INDEX IF NOT EXISTS idx_pr_user ON partner_referrals(referred_user_id);
CREATE INDEX IF NOT EXISTS idx_pc_partner ON partner_commissions(partner_id);
CREATE INDEX IF NOT EXISTS idx_pc_referral ON partner_commissions(referral_id);
CREATE INDEX IF NOT EXISTS idx_partners_code ON partners(code);
CREATE INDEX IF NOT EXISTS idx_partners_user ON partners(user_id);

-- RLS
ALTER TABLE partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_commissions ENABLE ROW LEVEL SECURITY;

-- Partners: own data readable; admin can do everything
DROP POLICY IF EXISTS partners_select ON partners;
CREATE POLICY partners_select ON partners FOR SELECT USING (
  user_id = auth.uid()
);

DROP POLICY IF EXISTS partners_admin_all ON partners;
CREATE POLICY partners_admin_all ON partners FOR ALL USING (
  EXISTS (
    SELECT 1 FROM admin_users a
    WHERE a.user_id = auth.uid() 
    AND a.role IN ('super_admin', 'support', 'finance')
    AND a.is_active = TRUE
  )
);

-- Partner referrals: partner sees own referrals
DROP POLICY IF EXISTS pr_select ON partner_referrals;
CREATE POLICY pr_select ON partner_referrals FOR SELECT USING (
  partner_id IN (SELECT id FROM partners WHERE user_id = auth.uid())
);

DROP POLICY IF EXISTS pr_admin_all ON partner_referrals;
CREATE POLICY pr_admin_all ON partner_referrals FOR ALL USING (
  EXISTS (
    SELECT 1 FROM admin_users a
    WHERE a.user_id = auth.uid() 
    AND a.role IN ('super_admin', 'support', 'finance')
    AND a.is_active = TRUE
  )
);

-- Partner commissions: partner sees own commissions
DROP POLICY IF EXISTS pc_select ON partner_commissions;
CREATE POLICY pc_select ON partner_commissions FOR SELECT USING (
  partner_id IN (SELECT id FROM partners WHERE user_id = auth.uid())
);

DROP POLICY IF EXISTS pc_admin_all ON partner_commissions;
CREATE POLICY pc_admin_all ON partner_commissions FOR ALL USING (
  EXISTS (
    SELECT 1 FROM admin_users a
    WHERE a.user_id = auth.uid() 
    AND a.role IN ('super_admin', 'support', 'finance')
    AND a.is_active = TRUE
  )
);

GRANT ALL ON partners TO authenticated;
GRANT ALL ON partner_referrals TO authenticated;
GRANT ALL ON partner_commissions TO authenticated;
