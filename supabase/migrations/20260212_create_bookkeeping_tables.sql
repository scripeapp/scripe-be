-- Create bookkeeping_transactions table
CREATE TABLE IF NOT EXISTS bookkeeping_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
  
  type VARCHAR(20) NOT NULL CHECK (type IN ('income', 'expense')),
  category VARCHAR(50) NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'NGN',
  
  description TEXT,
  transaction_date TIMESTAMPTZ DEFAULT NOW(),
  
  -- Reference to original entity (e.g., store_order.id)
  reference_id UUID,
  reference_type VARCHAR(50), -- 'store_order', 'referral_reward', 'manual'
  
  receipt_url TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_bookkeeping_business_id ON bookkeeping_transactions(business_id);
CREATE INDEX IF NOT EXISTS idx_bookkeeping_store_id ON bookkeeping_transactions(store_id);
CREATE INDEX IF NOT EXISTS idx_bookkeeping_type ON bookkeeping_transactions(type);
CREATE INDEX IF NOT EXISTS idx_bookkeeping_date ON bookkeeping_transactions(transaction_date);

-- Enable RLS
ALTER TABLE bookkeeping_transactions ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Merchants can see their own business transactions
CREATE POLICY "Merchants can view their own transactions"
  ON bookkeeping_transactions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM businesses b
      WHERE b.id = bookkeeping_transactions.business_id
      AND b.user_id = auth.uid()
    )
  );

-- Merchants can insert their own business transactions
CREATE POLICY "Merchants can insert their own transactions"
  ON bookkeeping_transactions FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM businesses b
      WHERE b.id = bookkeeping_transactions.business_id
      AND b.user_id = auth.uid()
    )
  );

-- Merchants can update their own business transactions
CREATE POLICY "Merchants can update their own transactions"
  ON bookkeeping_transactions FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM businesses b
      WHERE b.id = bookkeeping_transactions.business_id
      AND b.user_id = auth.uid()
    )
  );

-- Merchants can delete their own business transactions
CREATE POLICY "Merchants can delete their own transactions"
  ON bookkeeping_transactions FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM businesses b
      WHERE b.id = bookkeeping_transactions.business_id
      AND b.user_id = auth.uid()
    )
  );

-- Trigger for updated_at
DROP TRIGGER IF EXISTS bookkeeping_transactions_set_updated_at ON bookkeeping_transactions;
CREATE TRIGGER bookkeeping_transactions_set_updated_at
BEFORE UPDATE ON bookkeeping_transactions
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
