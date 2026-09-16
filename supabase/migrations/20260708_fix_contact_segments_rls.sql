-- Fix RLS insert violation on contact_segments and segment_activity.
--
-- Root cause: FOR ALL USING (...) without WITH CHECK means PostgreSQL
-- uses the USING expression for inserts too, but the implicit fallback
-- doesn't always evaluate correctly against the new row — causing
-- "new row violates row-level security policy (USING expression)".
--
-- Fix: explicitly declare WITH CHECK with the same predicate so
-- INSERT/UPDATE checks are unambiguous.

DROP POLICY IF EXISTS "Business member access via segment" ON contact_segments;
CREATE POLICY "Business member access via segment" ON contact_segments
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM segments s
      WHERE s.id = contact_segments.segment_id
        AND is_business_member(s.business_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM segments s
      WHERE s.id = contact_segments.segment_id
        AND is_business_member(s.business_id)
    )
  );

DROP POLICY IF EXISTS "Business member access via segment" ON segment_activity;
CREATE POLICY "Business member access via segment" ON segment_activity
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM segments s
      WHERE s.id = segment_activity.segment_id
        AND is_business_member(s.business_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM segments s
      WHERE s.id = segment_activity.segment_id
        AND is_business_member(s.business_id)
    )
  );
