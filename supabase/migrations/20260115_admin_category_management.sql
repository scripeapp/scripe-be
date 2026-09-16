-- Admin Category Management Enhancement
-- Adds columns and RLS policies for admin CRUD operations on business_categories

BEGIN;

-- 1. Add new columns to business_categories
ALTER TABLE business_categories
  ADD COLUMN IF NOT EXISTS icon VARCHAR(100),
  ADD COLUMN IF NOT EXISTS display_order INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS description TEXT;

-- 2. Create index on display_order for efficient sorting
CREATE INDEX IF NOT EXISTS idx_business_categories_display_order 
  ON business_categories(display_order);

-- 3. Create index on is_active for filtering
CREATE INDEX IF NOT EXISTS idx_business_categories_is_active 
  ON business_categories(is_active);

-- 4. Set default display_order based on existing order
UPDATE business_categories 
SET display_order = sub.row_num
FROM (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY COALESCE(parent_id::text, 'root')
    ORDER BY label
  ) as row_num
  FROM business_categories
) AS sub
WHERE business_categories.id = sub.id
  AND business_categories.display_order = 0;

-- 5. Admin INSERT policy (allows admins to add categories via service role)
-- Note: Admin operations go through service role which bypasses RLS
-- But we add this for documentation and if ever switching to direct admin auth

DROP POLICY IF EXISTS business_categories_admin_insert_policy ON business_categories;
CREATE POLICY business_categories_admin_insert_policy ON business_categories
  FOR INSERT
  WITH CHECK (
    -- Only service role or users in admin_users table can insert
    (current_setting('request.jwt.claims', true)::json->>'role' = 'service_role')
    OR EXISTS (
      SELECT 1 FROM admin_users 
      WHERE user_id = auth.uid() 
      AND is_active = true
    )
  );

-- 6. Admin UPDATE policy
DROP POLICY IF EXISTS business_categories_admin_update_policy ON business_categories;
CREATE POLICY business_categories_admin_update_policy ON business_categories
  FOR UPDATE
  USING (
    (current_setting('request.jwt.claims', true)::json->>'role' = 'service_role')
    OR EXISTS (
      SELECT 1 FROM admin_users 
      WHERE user_id = auth.uid() 
      AND is_active = true
    )
  )
  WITH CHECK (
    (current_setting('request.jwt.claims', true)::json->>'role' = 'service_role')
    OR EXISTS (
      SELECT 1 FROM admin_users 
      WHERE user_id = auth.uid() 
      AND is_active = true
    )
  );

-- 7. Admin DELETE policy (soft delete via is_active, but allow hard delete for admins)
DROP POLICY IF EXISTS business_categories_admin_delete_policy ON business_categories;
CREATE POLICY business_categories_admin_delete_policy ON business_categories
  FOR DELETE
  USING (
    (current_setting('request.jwt.claims', true)::json->>'role' = 'service_role')
    OR EXISTS (
      SELECT 1 FROM admin_users 
      WHERE user_id = auth.uid() 
      AND is_active = true
      AND role IN ('super_admin', 'support')
    )
  );

-- 8. Create trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_business_categories_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_business_categories_updated_at ON business_categories;
CREATE TRIGGER trigger_business_categories_updated_at
  BEFORE UPDATE ON business_categories
  FOR EACH ROW
  EXECUTE FUNCTION update_business_categories_updated_at();

COMMIT;
