-- Add variant group support to product_variants table
-- Allows multiple variant groups with different display styles per product

ALTER TABLE product_variants 
ADD COLUMN IF NOT EXISTS group_name TEXT DEFAULT 'Options',
ADD COLUMN IF NOT EXISTS group_ui_type TEXT DEFAULT 'pills';

-- Add check constraint for group_ui_type
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_group_ui_type_check'
    ) THEN
        ALTER TABLE product_variants 
        ADD CONSTRAINT product_variants_group_ui_type_check 
        CHECK (group_ui_type IN ('pills', 'color', 'dropdown'));
    END IF;
END $$;

-- Create index for efficient grouping queries
CREATE INDEX IF NOT EXISTS idx_product_variants_group ON product_variants(product_id, group_name);
