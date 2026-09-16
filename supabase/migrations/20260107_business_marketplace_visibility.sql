-- Add marketplace_visibility column to businesses table
-- Controls whether products/stores from this business appear in public marketplace feeds
ALTER TABLE businesses 
ADD COLUMN IF NOT EXISTS marketplace_visibility BOOLEAN NOT NULL DEFAULT true;

-- Add comment for documentation
COMMENT ON COLUMN businesses.marketplace_visibility IS 'When false, products and stores from this business are hidden from public marketplace feeds';
