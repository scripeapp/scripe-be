-- Registers/POS Phase 5b: a POS staff PIN is now issued to an existing
-- business team member (memberships.user_id) rather than a free-typed
-- name — the merchant picks who from their already-invited team, the PIN
-- just gives that person a fast way to identify themselves at /pos without
-- a full dashboard login there.

ALTER TABLE pos_staff
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- One active PIN per team member per store.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_staff_store_user_active
  ON pos_staff(store_id, user_id)
  WHERE status = 'active' AND user_id IS NOT NULL;

COMMENT ON COLUMN pos_staff.user_id IS 'The business team member (auth.users id) this PIN was issued to.';
