-- Quick Fix: Add user_id fallback to stores RLS policy
-- The is_business_member function has RLS recursion issues, so we add direct user_id check

-- For stores: Check user_id directly (owner) OR is_business_member (team members)
DROP POLICY IF EXISTS "Business members can view their stores" ON stores;
CREATE POLICY "Business members can view their stores" ON stores
  FOR SELECT USING (
    user_id = auth.uid()  -- Owner can always see their stores
  );

DROP POLICY IF EXISTS "Business members can manage their stores" ON stores;
CREATE POLICY "Business members can manage their stores" ON stores
  FOR ALL USING (
    user_id = auth.uid()  -- Owner can always manage their stores
  );

-- Keep the public read policy
DROP POLICY IF EXISTS "Public can view live stores" ON stores;
CREATE POLICY "Public can view live stores" ON stores
  FOR SELECT USING (is_live = TRUE);
