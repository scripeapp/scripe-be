-- Add variant customization fields to products
ALTER TABLE products 
ADD COLUMN IF NOT EXISTS variant_group_name VARCHAR(50) DEFAULT 'Options',
ADD COLUMN IF NOT EXISTS variant_ui_type VARCHAR(20) DEFAULT 'pills'; -- 'pills' or 'color'

-- Add color support to product_variants
ALTER TABLE product_variants
ADD COLUMN IF NOT EXISTS color_value VARCHAR(50); -- hex code or css value
