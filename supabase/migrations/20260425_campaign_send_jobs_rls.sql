-- RLS policies for campaign_send_jobs
-- This table is written by the backend on behalf of authenticated business members.
-- Policies mirror the pattern used on campaigns/segments: is_business_member().

ALTER TABLE campaign_send_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Business members can insert send jobs"
  ON campaign_send_jobs FOR INSERT
  WITH CHECK (is_business_member(business_id::uuid));

CREATE POLICY "Business members can view send jobs"
  ON campaign_send_jobs FOR SELECT
  USING (is_business_member(business_id::uuid));

CREATE POLICY "Business members can update send jobs"
  ON campaign_send_jobs FOR UPDATE
  USING (is_business_member(business_id::uuid));
