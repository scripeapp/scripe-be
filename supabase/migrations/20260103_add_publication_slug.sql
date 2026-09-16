-- Migration: Add slug to publications
-- Standardizing on 'slug' across entities

ALTER TABLE publications ADD COLUMN IF NOT EXISTS slug VARCHAR(255);

-- Copy existing domain_name to slug
UPDATE publications SET slug = domain_name WHERE slug IS NULL;

-- Make it unique per user? (Actually publications might need globally unique slugs like stores)
-- For now, let's just make sure it exists to stop the frontend errors.
CREATE INDEX IF NOT EXISTS idx_publications_slug ON publications(slug);
