-- Migration: Add post_category to circle_posts
-- Adds a category column to differentiate between feed posts, announcements, and resources.

-- 1. Create the enum type
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'circle_post_category') THEN
        CREATE TYPE circle_post_category AS ENUM ('feed', 'announcement', 'resource');
    END IF;
END $$;

-- 2. Add the column to circle_posts
ALTER TABLE circle_posts 
ADD COLUMN IF NOT EXISTS post_category circle_post_category DEFAULT 'feed';

-- 3. Create index for performance
CREATE INDEX IF NOT EXISTS idx_circle_posts_category ON circle_posts(post_category);

-- 4. Backfill existing posts
-- Categorize based on content markers used previously
UPDATE circle_posts 
SET post_category = 'announcement' 
WHERE content LIKE '%<!--announcement:%' AND post_category = 'feed';

UPDATE circle_posts 
SET post_category = 'resource' 
WHERE (content LIKE '%<!--resource:%' OR post_type = 'link' OR link_url IS NOT NULL) 
AND post_category = 'feed';
