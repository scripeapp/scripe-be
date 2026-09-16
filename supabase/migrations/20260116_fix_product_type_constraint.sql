-- Fix product type constraint to include all product types
-- The original constraint only allowed 'digital', 'physical', 'service'
-- But we now support 'course', 'ebook', 'membership', 'bundle' as top-level types

DO $$ 
BEGIN
  -- Drop the existing constraint if it exists (it might be named products_type_check)
  -- We use ALTER TABLE ... DROP CONSTRAINT IF EXISTS
  ALTER TABLE products DROP CONSTRAINT IF EXISTS products_type_check;

  -- Verify if there are other constraints on the type column with auto-generated names?
  -- Usually we can just add the new one. The old one "products_type_check" is the standard name.
  
  -- Add the new constraint with all supported types
  ALTER TABLE products 
  ADD CONSTRAINT products_type_check 
  CHECK (type IN ('digital', 'physical', 'service', 'course', 'ebook', 'membership', 'bundle'));

END $$;
