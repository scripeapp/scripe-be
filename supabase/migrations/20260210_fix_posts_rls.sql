-- Add author-based policy for posts to ensure owners can manage their posts
-- This complements the existing business-member policy

-- 1. Allow owners to manage their own posts
DROP POLICY IF EXISTS "Authors can manage their own posts" ON posts;
CREATE POLICY "Authors can manage their own posts" ON posts
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 2. Ensure business members can still manage posts in their publication
-- (This is already covered by "Business members can manage their posts", 
-- but we make sure it's robust)
DROP POLICY IF EXISTS "Business members can manage their posts" ON posts;
CREATE POLICY "Business members can manage their posts" ON posts
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM publications p 
      WHERE p.id = posts.publication 
      AND is_business_member(p.business_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM publications p 
      WHERE p.id = posts.publication 
      AND is_business_member(p.business_id)
    )
  );
