-- Add plan_ids column to circle_courses for plan-based access control
ALTER TABLE circle_courses
  ADD COLUMN IF NOT EXISTS plan_ids uuid[] DEFAULT NULL;

COMMENT ON COLUMN circle_courses.plan_ids IS
  'If set, only members with an active subscription to one of these plan IDs can enroll.';
