-- ============================================================================
-- Fix: Marketplace Visibility RLS
-- Allows anyone to read businesses that have marketplace_visibility = true
-- This ensures that the !inner join in marketplace queries works for all users
-- ============================================================================

DROP POLICY IF EXISTS "Public can view marketplace visible businesses" ON businesses;
CREATE POLICY "Public can view marketplace visible businesses" ON businesses
  FOR SELECT USING (marketplace_visibility = true);
