-- ============================================================================
-- Generic conditional event pricing
-- ============================================================================
-- Adds a forward-compatible pricing-rule model to events. The first rule type
-- ("segment_membership") surcharges attendees who are not on an uploaded CRM
-- members list. Each issued ticket records the adjustment applied, and a
-- per-reference snapshot makes the webhook the authoritative source of pricing.
-- ============================================================================

BEGIN;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS pricing_rules jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Pricing tier labels: 'member' (waived), 'surcharged', 'standard' (no rule).
-- 'member' rows are what redemption-cap counting reads.
ALTER TABLE issued_tickets
  ADD COLUMN IF NOT EXISTS price_adjustment numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pricing_tier varchar(40);

CREATE TABLE IF NOT EXISTS event_pricing_snapshots (
  reference text PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  base_total numeric(12, 2) NOT NULL DEFAULT 0,
  adjustment_total numeric(12, 2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'NGN',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_pricing_snapshots_event_id
  ON event_pricing_snapshots(event_id);

-- Written at checkout and read by the payment webhook — both run with the
-- service role, so no anon/authenticated access is granted.
ALTER TABLE event_pricing_snapshots ENABLE ROW LEVEL SECURITY;

COMMIT;
