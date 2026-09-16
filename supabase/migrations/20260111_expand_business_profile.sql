-- Expand businesses table with full profile settings
-- Includes branding, contact details, and improved configuration options

ALTER TABLE businesses
ADD COLUMN IF NOT EXISTS cover_image TEXT,
ADD COLUMN IF NOT EXISTS logo_url TEXT,
ADD COLUMN IF NOT EXISTS primary_color TEXT,
ADD COLUMN IF NOT EXISTS description TEXT,
ADD COLUMN IF NOT EXISTS support_email TEXT,
ADD COLUMN IF NOT EXISTS support_phone TEXT,
ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD',
ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'UTC',
ADD COLUMN IF NOT EXISTS social_links JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS address JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS policies JSONB DEFAULT '{}'::jsonb;

-- Add comments for documentation
COMMENT ON COLUMN businesses.cover_image IS 'URL to the store/business banner image';
COMMENT ON COLUMN businesses.logo_url IS 'URL to the business logo';
COMMENT ON COLUMN businesses.primary_color IS 'Hex code for store branding (e.g. #FF5733)';
COMMENT ON COLUMN businesses.description IS 'Short bio or tagline for the business';
COMMENT ON COLUMN businesses.currency IS 'Default currency for the business (e.g. USD, NGN)';
COMMENT ON COLUMN businesses.social_links IS 'JSON object containing social media handles (instagram, twitter, website, linkedin)';
COMMENT ON COLUMN businesses.address IS 'JSON object containing physical address (street, city, country, zip)';
COMMENT ON COLUMN businesses.policies IS 'JSON object containing return_policy, terms_conditions, etc.';
