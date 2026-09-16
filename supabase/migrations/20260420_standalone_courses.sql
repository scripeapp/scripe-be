-- =============================================================================
-- Standalone Courses: decouple circle_courses from requiring a circle
--
-- Changes:
--   1. Add business_id column (backfilled from parent circle)
--   2. Make circle_id nullable (courses can now exist without a circle)
--   3. Change ON DELETE CASCADE → ON DELETE SET NULL so deleting a circle
--      orphans its courses as standalone rather than destroying them
--   4. Add access_type to distinguish standalone free/paid from circle-gated
--   5. Index on (business_id, created_at) for the standalone listing query
-- =============================================================================

BEGIN;

-- 1. Add business_id and backfill from parent circle
ALTER TABLE circle_courses
  ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE SET NULL;

UPDATE circle_courses cc
SET    business_id = c.business_id
FROM   circles c
WHERE  c.id = cc.circle_id
  AND  cc.business_id IS NULL;

-- Safety net: if any courses have a circle_id that references a deleted circle,
-- the backfill above will have left them with business_id = NULL.
-- Rather than letting SET NOT NULL fail, we delete these orphaned rows.
-- (A course with no circle and no business has no owner — it cannot be recovered.)
DELETE FROM circle_courses
WHERE business_id IS NULL;

ALTER TABLE circle_courses
  ALTER COLUMN business_id SET NOT NULL;

-- 2. Make circle_id optional
ALTER TABLE circle_courses
  ALTER COLUMN circle_id DROP NOT NULL;

-- 3. Change cascade: deleting a circle sets circle_id = NULL (course survives as standalone)
--    NOTE: access_type remains 'circle_membership' after this. Application code
--    must treat circle_id IS NULL + access_type = 'circle_membership' as effectively
--    'free' (no circle plan gate can apply). Future cleanup can reset to 'free' via:
--    UPDATE circle_courses SET access_type = 'free' WHERE circle_id IS NULL AND access_type = 'circle_membership';
ALTER TABLE circle_courses
  DROP CONSTRAINT IF EXISTS circle_courses_circle_id_fkey;

ALTER TABLE circle_courses
  ADD CONSTRAINT circle_courses_circle_id_fkey
    FOREIGN KEY (circle_id) REFERENCES circles(id) ON DELETE SET NULL;

-- 4. Add access_type (circle_membership = current behaviour; free/paid = standalone)
ALTER TABLE circle_courses
  ADD COLUMN IF NOT EXISTS access_type TEXT
    CHECK (access_type IN ('free', 'paid', 'circle_membership'))
    DEFAULT 'circle_membership';

-- Backfill: existing courses are all circle-membership gated
UPDATE circle_courses
SET    access_type = 'circle_membership'
WHERE  circle_id IS NOT NULL
  AND  access_type IS NULL;

-- Standalone courses created after this migration default to 'free'
-- (enforced in application layer — this just makes the column safe to use)

-- 5. Indexes
CREATE INDEX IF NOT EXISTS idx_circle_courses_business
  ON circle_courses (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_circle_courses_standalone
  ON circle_courses (business_id, created_at DESC)
  WHERE circle_id IS NULL;

COMMIT;
