-- Backfill slug for any business that is missing one.
-- Slug is derived from the business name (slugified). Collisions — whether
-- against existing slugs or within the backfilled batch — get a short id
-- suffix to satisfy the UNIQUE constraint on businesses.slug.

WITH prepared AS (
  SELECT
    id,
    COALESCE(
      NULLIF(
        TRIM(
          BOTH '-' FROM REGEXP_REPLACE(
            LOWER(COALESCE(name, 'business')),
            '[^a-z0-9]+',
            '-',
            'g'
          )
        ),
        ''
      ),
      'business'
    ) AS base_slug
  FROM businesses
  WHERE slug IS NULL OR TRIM(slug) = ''
),
ranked AS (
  SELECT
    p.id,
    p.base_slug,
    -- Order within a base_slug group for deterministic suffixing
    ROW_NUMBER() OVER (PARTITION BY p.base_slug ORDER BY p.id) AS slug_rank,
    -- Does this base already exist on a business that we are NOT backfilling?
    EXISTS (
      SELECT 1
      FROM businesses b
      WHERE b.slug = p.base_slug
        AND b.id NOT IN (SELECT id FROM prepared)
    ) AS base_taken
  FROM prepared p
)
UPDATE businesses
SET slug = CASE
  WHEN ranked.slug_rank = 1 AND NOT ranked.base_taken THEN ranked.base_slug
  ELSE ranked.base_slug || '-' || LEFT(businesses.id::text, 8)
END
FROM ranked
WHERE businesses.id = ranked.id
  AND (businesses.slug IS NULL OR TRIM(businesses.slug) = '');
