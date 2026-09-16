-- Fix: Add public read access to discount codes for checkout validation
-- The public store checkout needs to validate discount codes, but RLS blocks anonymous access

-- Add public read policy for active discount codes
DROP POLICY IF EXISTS "Public can view active discount codes" ON discount_codes;
CREATE POLICY "Public can view active discount codes" ON discount_codes
  FOR SELECT USING (is_active = TRUE);
