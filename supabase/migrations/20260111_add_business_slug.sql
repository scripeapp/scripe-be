-- Add slug column to businesses table
-- Slug must be unique and is used for public URLs

ALTER TABLE businesses
ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE;

-- Create an index for faster lookups by slug
CREATE INDEX IF NOT EXISTS idx_businesses_slug ON businesses(slug);

COMMENT ON COLUMN businesses.slug IS 'Unique URL-friendly identifier for the business';
