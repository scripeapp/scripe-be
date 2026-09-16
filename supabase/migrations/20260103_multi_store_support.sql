-- Migration: Enable multiple stores per user
-- Date: 2026-01-03

-- =============================================================================
-- 1. Drop unique constraint on stores.user_id to allow multiple stores per user
-- =============================================================================
ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_user_id_key;

-- Ensure index exists for efficient lookups
CREATE INDEX IF NOT EXISTS idx_stores_user_id ON stores(user_id);

-- =============================================================================
-- 2. Create user_preferences table for tracking last active entities
-- =============================================================================
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  last_active_store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
  last_active_publication_id UUID REFERENCES publications(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for quick preference lookups
CREATE INDEX IF NOT EXISTS idx_user_preferences_store ON user_preferences(last_active_store_id);
CREATE INDEX IF NOT EXISTS idx_user_preferences_publication ON user_preferences(last_active_publication_id);

-- =============================================================================
-- 3. Initialize preferences for existing users with stores
-- =============================================================================
INSERT INTO user_preferences (user_id, last_active_store_id, updated_at)
SELECT DISTINCT 
  s.user_id,
  (SELECT id FROM stores s2 WHERE s2.user_id = s.user_id ORDER BY created_at ASC LIMIT 1),
  NOW()
FROM stores s
ON CONFLICT (user_id) DO NOTHING;

-- =============================================================================
-- 4. Also initialize for users with publications but no stores
-- =============================================================================
INSERT INTO user_preferences (user_id, last_active_publication_id, updated_at)
SELECT DISTINCT 
  p.user_id,
  (SELECT id FROM publications p2 WHERE p2.user_id = p.user_id ORDER BY created_at ASC LIMIT 1),
  NOW()
FROM publications p
WHERE NOT EXISTS (SELECT 1 FROM user_preferences up WHERE up.user_id = p.user_id)
ON CONFLICT (user_id) DO UPDATE SET 
  last_active_publication_id = EXCLUDED.last_active_publication_id,
  updated_at = NOW();
