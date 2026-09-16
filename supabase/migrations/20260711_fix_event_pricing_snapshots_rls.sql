BEGIN;

-- Add RLS policies for event_pricing_snapshots so authenticated users (business
-- members) can insert and read snapshots without needing the service role key.
-- The original migration (20260630) enabled RLS but created no policies, which
-- caused 42501 errors when supabaseAdmin was unavailable.

CREATE POLICY "Business members can insert pricing snapshots"
  ON event_pricing_snapshots
  FOR INSERT
  WITH CHECK (
    is_business_member(
      (SELECT business_id FROM events WHERE id = event_id)
    )
  );

CREATE POLICY "Business members can view pricing snapshots"
  ON event_pricing_snapshots
  FOR SELECT
  USING (
    is_business_member(
      (SELECT business_id FROM events WHERE id = event_id)
    )
  );

COMMIT;
