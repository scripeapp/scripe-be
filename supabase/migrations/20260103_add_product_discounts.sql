-- Add compare_at_price to products and product_variants
-- This allows for showing original price strikethroughs and discount percentages on the storefront.

-- 1. Update products table
ALTER TABLE products 
ADD COLUMN IF NOT EXISTS compare_at_price DECIMAL(10, 2);

-- 2. Update product_variants table
ALTER TABLE product_variants
ADD COLUMN IF NOT EXISTS compare_at_price DECIMAL(10, 2);
