-- ============================================================================
-- Payout Requests
-- ============================================================================
-- Replaces the unused `payout_batches` settlement-mirror table with a
-- purpose-built payout request log. Lifecycle: pending -> fulfilled | failed,
-- driven solely by Paystack settlement webhooks. Members create and read their
-- own requests; status transitions happen via the service role (webhook).
-- ============================================================================

BEGIN;

-- `payout_batches` was scaffolding for a Paystack settlement mirror that was
-- never populated and only referenced inside financials.service. Remove it.
DROP TABLE IF EXISTS payout_batches CASCADE;

CREATE TABLE IF NOT EXISTS payout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  requested_by uuid,
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'fulfilled', 'failed')),
  paystack_settlement_id varchar(100),
  failure_reason text,
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payout_requests_business_id
  ON payout_requests(business_id);
CREATE INDEX IF NOT EXISTS idx_payout_requests_status
  ON payout_requests(status);

ALTER TABLE payout_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read payout_requests" ON payout_requests;
CREATE POLICY "members read payout_requests" ON payout_requests
  FOR SELECT USING (is_business_member(business_id));

DROP POLICY IF EXISTS "members create payout_requests" ON payout_requests;
CREATE POLICY "members create payout_requests" ON payout_requests
  FOR INSERT WITH CHECK (is_business_member(business_id));

COMMIT;
