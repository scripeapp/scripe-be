-- Core Financials Module - Database Layer
-- Migration: 20260216_financials_core.sql

-- =============================================================================
-- 1. Create financial_refunds table
-- =============================================================================
CREATE TABLE IF NOT EXISTS financial_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  
  -- Reference to the original transaction
  source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('store_order', 'event_order', 'subscription')),
  reference_id UUID NOT NULL, -- The ID of the order or subscription record
  
  amount DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'NGN',
  reason TEXT,
  
  -- Tracking
  paystack_refund_id VARCHAR(100), -- Reference from gateway if available
  status VARCHAR(20) DEFAULT 'processed' CHECK (status IN ('pending', 'processed', 'failed')),
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_financial_refunds_business_id ON financial_refunds(business_id);
CREATE INDEX IF NOT EXISTS idx_financial_refunds_reference_id ON financial_refunds(reference_id);

-- =============================================================================
-- 2. Create expenses table
-- =============================================================================
CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  
  category VARCHAR(50) NOT NULL, -- 'Venue', 'Marketing', 'Equipment', 'Other'
  amount DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'NGN',
  description TEXT,
  transaction_date TIMESTAMPTZ DEFAULT NOW(),
  
  -- Optional linkage
  receipt_url TEXT,
  linked_event_id UUID REFERENCES events(id) ON DELETE SET NULL,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_business_id ON expenses(business_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(transaction_date);

-- =============================================================================
-- 3. Create payout_batches table (Settlement tracking)
-- =============================================================================
CREATE TABLE IF NOT EXISTS payout_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  
  batch_id VARCHAR(100) UNIQUE, -- Paystack settlement ID
  amount DECIMAL(12, 2) NOT NULL, -- Net amount received
  fees DECIMAL(12, 2) DEFAULT 0, -- Total gateway fees deducted
  
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed')),
  settled_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_batches_business_id ON payout_batches(business_id);


-- =============================================================================
-- 5. RLS Policies
-- =============================================================================
ALTER TABLE financial_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_batches ENABLE ROW LEVEL SECURITY;

-- Helper function check (assumed to exist based on other migrations)
-- is_business_member(uuid) 

DROP POLICY IF EXISTS "Business member access refunds" ON financial_refunds;
CREATE POLICY "Business member access refunds" ON financial_refunds FOR ALL USING (is_business_member(business_id));

DROP POLICY IF EXISTS "Business member access expenses" ON expenses;
CREATE POLICY "Business member access expenses" ON expenses FOR ALL USING (is_business_member(business_id));

DROP POLICY IF EXISTS "Business member access payout_batches" ON payout_batches;
CREATE POLICY "Business member access payout_batches" ON payout_batches FOR ALL USING (is_business_member(business_id));


-- Trigger for updated_at on new tables
DROP TRIGGER IF EXISTS financial_refunds_set_updated_at ON financial_refunds;
CREATE TRIGGER financial_refunds_set_updated_at BEFORE UPDATE ON financial_refunds FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS expenses_set_updated_at ON expenses;
CREATE TRIGGER expenses_set_updated_at BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
