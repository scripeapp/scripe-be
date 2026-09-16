-- ============================================================================
-- Fix RLS for CRM Junction Tables
-- contact_segments and segment_activity tables need proper RLS policies
-- ============================================================================

-- 1. Enable RLS on junction tables
ALTER TABLE contact_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE segment_activity ENABLE ROW LEVEL SECURITY;

-- 2. Create RLS policies for contact_segments
-- Allow access if user has access to the segment (via business_id)
DROP POLICY IF EXISTS "Business member access via segment" ON contact_segments;
CREATE POLICY "Business member access via segment" ON contact_segments
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM segments s
      WHERE s.id = contact_segments.segment_id
      AND is_business_member(s.business_id)
    )
  );

-- 3. Create RLS policies for segment_activity
DROP POLICY IF EXISTS "Business member access via segment" ON segment_activity;
CREATE POLICY "Business member access via segment" ON segment_activity
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM segments s
      WHERE s.id = segment_activity.segment_id
      AND is_business_member(s.business_id)
    )
  );
