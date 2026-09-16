-- Add plan_ids to circle_courses for access control
-- NULL = accessible to all members, array of plan IDs = restricted to those plans

ALTER TABLE circle_courses
  ADD COLUMN IF NOT EXISTS plan_ids text[] DEFAULT NULL;

-- RLS already handled by permissive policies from previous migration
