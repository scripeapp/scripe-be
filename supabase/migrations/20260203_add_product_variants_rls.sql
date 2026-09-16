-- Enable RLS on product_variants
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;

-- Business Member Policy (Manage)
-- Allows business members to view, insert, update, delete variants for products in their stores.
DROP POLICY IF EXISTS "Business members can manage product variants" ON product_variants;
CREATE POLICY "Business members can manage product variants" ON product_variants
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM products p
      JOIN stores s ON p.store_id = s.id
      WHERE p.id = product_variants.product_id
      AND is_business_member(s.business_id)
    )
  );

-- Public Read Policy
-- Allows anyone to view active variants of published products.
DROP POLICY IF EXISTS "Public can view active product variants" ON product_variants;
CREATE POLICY "Public can view active product variants" ON product_variants
  FOR SELECT USING (
    is_active = true
    AND EXISTS (
        SELECT 1 FROM products p
        WHERE p.id = product_variants.product_id
        AND p.status = 'published'
    )
  );
