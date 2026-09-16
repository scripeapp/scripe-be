-- Add Business Categories and Sub-categories
-- Enables dynamic fetching of categories and stores selection on businesses

BEGIN;

-- 1. Create business_categories table
CREATE TABLE IF NOT EXISTS business_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug VARCHAR(100) NOT NULL,
  label VARCHAR(100) NOT NULL,
  parent_id UUID REFERENCES business_categories(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Ensure unique slugs within same parent scope (or globally? let's do global for simplicity)
  CONSTRAINT uq_category_slug UNIQUE (slug)
);

-- Index for parent_id for faster tree traversal
CREATE INDEX IF NOT EXISTS idx_business_categories_parent_id ON business_categories(parent_id);

-- 2. Seed Initial Data
DO $$
DECLARE
  v_retail_id UUID;
  v_services_id UUID;
  v_fb_id UUID;
  v_digital_id UUID;
  v_other_id UUID;
BEGIN
  -- Retail
  INSERT INTO business_categories (slug, label, parent_id)
  VALUES ('retail', 'Retail', NULL)
  RETURNING id INTO v_retail_id;

  INSERT INTO business_categories (slug, label, parent_id) VALUES
  ('clothing', 'Clothing & Apparel', v_retail_id),
  ('electronics', 'Electronics', v_retail_id),
  ('grocery', 'Grocery', v_retail_id),
  ('home_garden', 'Home & Garden', v_retail_id),
  ('jewelry', 'Jewelry', v_retail_id),
  ('beauty', 'Beauty', v_retail_id),
  ('other_retail', 'Other Retail', v_retail_id);

  -- Services
  INSERT INTO business_categories (slug, label, parent_id)
  VALUES ('services', 'Services', NULL)
  RETURNING id INTO v_services_id;

  INSERT INTO business_categories (slug, label, parent_id) VALUES
  ('consulting', 'Consulting', v_services_id),
  ('home_services', 'Home Services', v_services_id),
  ('health_wellness', 'Health & Wellness', v_services_id),
  ('education', 'Education', v_services_id),
  ('financial', 'Financial', v_services_id),
  ('legal', 'Legal', v_services_id),
  ('other_services', 'Other Services', v_services_id);

  -- Food & Beverage
  INSERT INTO business_categories (slug, label, parent_id)
  VALUES ('food_beverage', 'Food & Beverage', NULL)
  RETURNING id INTO v_fb_id;

  INSERT INTO business_categories (slug, label, parent_id) VALUES
  ('restaurant', 'Restaurant', v_fb_id),
  ('cafe', 'Cafe', v_fb_id),
  ('food_truck', 'Food Truck', v_fb_id),
  ('catering', 'Catering', v_fb_id),
  ('bakery', 'Bakery', v_fb_id),
  ('other_food', 'Other Food', v_fb_id);

  -- Digital Products
  INSERT INTO business_categories (slug, label, parent_id)
  VALUES ('digital_products', 'Digital Products', NULL)
  RETURNING id INTO v_digital_id;

  INSERT INTO business_categories (slug, label, parent_id) VALUES
  ('software', 'Software', v_digital_id),
  ('ebooks', 'E-books', v_digital_id),
  ('courses', 'Courses', v_digital_id),
  ('digital_art', 'Digital Art', v_digital_id),
  ('other_digital', 'Other Digital', v_digital_id);

  -- Other
  INSERT INTO business_categories (slug, label, parent_id)
  VALUES ('other', 'Other', NULL)
  RETURNING id INTO v_other_id;

  INSERT INTO business_categories (slug, label, parent_id) VALUES
  ('non_profit', 'Non-Profit', v_other_id),
  ('community', 'Community', v_other_id),
  ('personal', 'Personal', v_other_id),
  ('other_misc', 'Other', v_other_id);

END $$;

-- 3. Update businesses table
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS category_slug VARCHAR(100) REFERENCES business_categories(slug),
  ADD COLUMN IF NOT EXISTS sub_category_slug VARCHAR(100) REFERENCES business_categories(slug);

-- 4. RLS for business_categories (Public Read Only)
ALTER TABLE business_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY business_categories_select_policy ON business_categories
  FOR SELECT USING (true); -- Publicly readable

-- No INSERT/UPDATE/DELETE policies needed for now as it's static data managed by migrations/admins

COMMIT;
