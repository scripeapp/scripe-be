
-- Fix RLS policies to include Personal Owners (user_id) fallback
-- Current policies rely solely on is_business_member(business_id) which might fail for:
-- 1. Personal publications (business_id is null) - though check showed it exists here.
-- 2. Users who are owners but maybe not correctly mapped in business_members table?

-- 1. Publications
DROP POLICY IF EXISTS "Business members can manage their publications" ON publications;
CREATE POLICY "Owners and Business members can manage their publications" ON publications
  FOR ALL USING (
    (business_id IS NOT NULL AND is_business_member(business_id))
    OR
    (user_id = auth.uid())
  );

-- 2. Posts
DROP POLICY IF EXISTS "Business members can manage their posts" ON posts;
CREATE POLICY "Owners and Business members can manage their posts" ON posts
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM publications p 
      WHERE p.id = posts.publication 
      AND (
        (p.business_id IS NOT NULL AND is_business_member(p.business_id))
        OR 
        p.user_id = auth.uid()
      )
    )
  );

-- 3. Subscriptions (view only)
DROP POLICY IF EXISTS "Business members can view their subscriptions" ON subscriptions;
CREATE POLICY "Owners and Business members can view their subscriptions" ON subscriptions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM publications p 
      WHERE p.id = subscriptions.publication_id 
      AND (
        (p.business_id IS NOT NULL AND is_business_member(p.business_id))
        OR 
        p.user_id = auth.uid()
      )
    )
  );
