-- Add Session Payments Table for Revenue Tracking
-- This enables real revenue calculation instead of placeholder

BEGIN;

-- Create session_payments table
CREATE TABLE IF NOT EXISTS session_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'NGN',
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'refunded')),
  payment_reference VARCHAR(255) UNIQUE,
  payment_method VARCHAR(50),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_session_payments_session_id ON session_payments(session_id);
CREATE INDEX IF NOT EXISTS idx_session_payments_user_id ON session_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_session_payments_status ON session_payments(status);
CREATE INDEX IF NOT EXISTS idx_session_payments_reference ON session_payments(payment_reference);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS session_payments_set_updated_at ON session_payments;
CREATE TRIGGER session_payments_set_updated_at
BEFORE UPDATE ON session_payments
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- Enable RLS
ALTER TABLE session_payments ENABLE ROW LEVEL SECURITY;

-- RLS Policies

-- SELECT: Users can view their own payments, facilitators can view all session payments
DROP POLICY IF EXISTS session_payments_select_policy ON session_payments;
CREATE POLICY session_payments_select_policy ON session_payments FOR SELECT USING (
  user_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.id = session_payments.session_id
    AND (
      s.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM session_members sm
        WHERE sm.session_id = s.id
        AND sm.user_id = auth.uid()
        AND sm.role = 'facilitator'
      )
    )
  )
);

-- INSERT: Only authenticated users can create payment records (via webhook or direct payment)
DROP POLICY IF EXISTS session_payments_insert_policy ON session_payments;
CREATE POLICY session_payments_insert_policy ON session_payments FOR INSERT WITH CHECK (
  user_id = auth.uid()
);

-- UPDATE: Only facilitators can update payment status (for manual verification)
DROP POLICY IF EXISTS session_payments_update_policy ON session_payments;
CREATE POLICY session_payments_update_policy ON session_payments FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.id = session_payments.session_id
    AND (
      s.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM session_members sm
        WHERE sm.session_id = s.id
        AND sm.user_id = auth.uid()
        AND sm.role = 'facilitator'
      )
    )
  )
);

-- DELETE: Only session creator can delete payment records
DROP POLICY IF EXISTS session_payments_delete_policy ON session_payments;
CREATE POLICY session_payments_delete_policy ON session_payments FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.id = session_payments.session_id
    AND s.creator_id = auth.uid()
  )
);

-- Grant permissions
GRANT ALL ON session_payments TO authenticated;

-- Comments for documentation
COMMENT ON TABLE session_payments IS 'Tracks payments for paid sessions to calculate revenue';
COMMENT ON COLUMN session_payments.amount IS 'Payment amount in the specified currency';
COMMENT ON COLUMN session_payments.status IS 'Payment status: pending, success, failed, or refunded';
COMMENT ON COLUMN session_payments.payment_reference IS 'Unique reference from payment provider (e.g., Paystack)';
COMMENT ON COLUMN session_payments.metadata IS 'Additional payment data from provider';

COMMIT;
