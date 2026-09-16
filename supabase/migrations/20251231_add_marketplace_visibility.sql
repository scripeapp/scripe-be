-- Add marketplace_visibility column to users table
-- Controls whether user's content appears in public marketplace feeds

ALTER TABLE users 
ADD COLUMN IF NOT EXISTS marketplace_visibility BOOLEAN NOT NULL DEFAULT true;

-- Add comment for documentation
COMMENT ON COLUMN users.marketplace_visibility IS 'When false, user content is hidden from public marketplace feeds but still accessible via direct links';
