-- pos_staff RLS omitted the `m.status = 'active'` check that memberships'
-- own RLS enforces (see 20260105_team_final_stability_fix.sql), so a
-- suspended member could still view/manage another store's till staff.
-- Bringing pos_staff's policies in line, same inline stores/memberships
-- join style as the original (20260731_pos_staff_pins.sql) rather than
-- switching to the is_business_member() helper, to keep this a narrow fix.

DROP POLICY IF EXISTS "Business members can view pos_staff" ON pos_staff;
DROP POLICY IF EXISTS "Business members can create pos_staff" ON pos_staff;
DROP POLICY IF EXISTS "Business members can update pos_staff" ON pos_staff;
DROP POLICY IF EXISTS "Business members can delete pos_staff" ON pos_staff;

CREATE POLICY "Business members can view pos_staff"
  ON pos_staff
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM stores s
      JOIN memberships m ON m.business_id = s.business_id
      WHERE s.id = pos_staff.store_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );

CREATE POLICY "Business members can create pos_staff"
  ON pos_staff
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM stores s
      JOIN memberships m ON m.business_id = s.business_id
      WHERE s.id = pos_staff.store_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );

CREATE POLICY "Business members can update pos_staff"
  ON pos_staff
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM stores s
      JOIN memberships m ON m.business_id = s.business_id
      WHERE s.id = pos_staff.store_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );

CREATE POLICY "Business members can delete pos_staff"
  ON pos_staff
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM stores s
      JOIN memberships m ON m.business_id = s.business_id
      WHERE s.id = pos_staff.store_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );
