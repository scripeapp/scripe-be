-- RLS Policies for Publications and Related Tables (Business-aware)
-- This migration ensures that publications and their related entities 
-- are only accessible by members of the associated business.

-- 1. Enable RLS on all publication-related tables
ALTER TABLE publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- 2. Drop legacy policies if they exist (based on user_id)
DROP POLICY IF EXISTS "Users can view their own publications" ON publications;
DROP POLICY IF EXISTS "Public can view publications" ON publications;

-- 3. Public Read Access (for marketplace and readers)
-- Note: We check marketplace_visibility for the marketplace, 
-- but individual publications are always viewable if you have the ID/slug.
DROP POLICY IF EXISTS "Anyone can view publications" ON publications;
CREATE POLICY "Anyone can view publications" ON publications
  FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "Anyone can view published posts" ON posts;
CREATE POLICY "Anyone can view published posts" ON posts
  FOR SELECT USING (status = 'published');

-- 4. Business Member Access (using is_business_member helper)
-- Note: is_business_member is defined in 20260104_teams_permissions_v2.sql

-- Publications
DROP POLICY IF EXISTS "Business members can manage their publications" ON publications;
CREATE POLICY "Business members can manage their publications" ON publications
  FOR ALL USING (is_business_member(business_id));

-- Posts (join with publications to get business_id)
DROP POLICY IF EXISTS "Business members can manage their posts" ON posts;
CREATE POLICY "Business members can manage their posts" ON posts
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM publications p 
      WHERE p.id = posts.publication 
      AND is_business_member(p.business_id)
    )
  );

-- Subscriptions (join with publications to get business_id)
DROP POLICY IF EXISTS "Business members can view their subscriptions" ON subscriptions;
CREATE POLICY "Business members can view their subscriptions" ON subscriptions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM publications p 
      WHERE p.id = subscriptions.publication_id 
      AND is_business_member(p.business_id)
    )
  );
