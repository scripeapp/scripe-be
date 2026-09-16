-- Drop the conflicting RLS policy on stores
-- This policy uses the problematic is_business_member() function which causes recursion
DROP POLICY IF EXISTS "Business member access" ON stores;
