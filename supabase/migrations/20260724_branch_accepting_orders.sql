-- Lets a merchant temporarily pause ordering at a branch (kitchen
-- overwhelmed, out of a key ingredient, closing early) without touching
-- is_active, which is a structural on/off (removes the branch from the
-- dashboard branch list entirely). accepting_orders is meant to be flipped
-- often; is_active is not.

ALTER TABLE store_branches
ADD COLUMN IF NOT EXISTS accepting_orders BOOLEAN NOT NULL DEFAULT true;
