-- Create store_categories table
CREATE TABLE IF NOT EXISTS public.store_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) NOT NULL,
  description TEXT,
  position INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Category slugs must be unique per store
  CONSTRAINT unique_store_category_slug UNIQUE(store_id, slug),
  -- Category names must be unique per store
  CONSTRAINT unique_store_category_name UNIQUE(store_id, name)
);

-- Create indexes for store_categories
CREATE INDEX IF NOT EXISTS idx_store_categories_store_id ON store_categories(store_id);
CREATE INDEX IF NOT EXISTS idx_store_categories_position ON store_categories(store_id, position);

-- Create product_categories junction table
CREATE TABLE IF NOT EXISTS public.product_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES store_categories(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Prevent duplicate assignments
  CONSTRAINT unique_product_category UNIQUE(product_id, category_id)
);

-- Create indexes for product_categories
CREATE INDEX IF NOT EXISTS idx_product_categories_product_id ON product_categories(product_id);
CREATE INDEX IF NOT EXISTS idx_product_categories_category_id ON product_categories(category_id);
