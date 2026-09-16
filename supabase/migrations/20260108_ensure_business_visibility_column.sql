-- Ensure marketplace_visibility column exists in businesses table
-- This is a fix for cases where the column might be missing
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'businesses' 
        AND column_name = 'marketplace_visibility'
    ) THEN
        ALTER TABLE businesses ADD COLUMN marketplace_visibility BOOLEAN NOT NULL DEFAULT true;
        COMMENT ON COLUMN businesses.marketplace_visibility IS 'When false, products and stores from this business are hidden from public marketplace feeds';
    END IF;
END $$;
