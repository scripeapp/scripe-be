-- Create marketplace_categories table
CREATE TABLE IF NOT EXISTS public.marketplace_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL UNIQUE,
  slug VARCHAR(100) NOT NULL UNIQUE,
  icon VARCHAR(10), -- Emoji or short icon code
  position INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.marketplace_categories ENABLE ROW LEVEL SECURITY;

-- Public read access
CREATE POLICY "Marketplace categories are viewable by everyone" 
ON public.marketplace_categories FOR SELECT 
USING (true);

-- Admin write access (service role only for now via seed)
-- We can add admin user policies later if needed

-- Add marketplace_category_id to products
ALTER TABLE public.products 
ADD COLUMN IF NOT EXISTS marketplace_category_id UUID REFERENCES public.marketplace_categories(id) ON DELETE SET NULL;

-- Create index for faster filtering
CREATE INDEX IF NOT EXISTS idx_products_marketplace_category ON products(marketplace_category_id);

-- Seed initial categories
INSERT INTO public.marketplace_categories (name, slug, icon, position) VALUES
('Fashion', 'fashion', '👕', 10),
('Beauty & Health', 'beauty-health', '💄', 20),
('Home & Living', 'home-living', '🏠', 30),
('Electronics & Gadgets', 'electronics', '📱', 40),
('Books & Stationery', 'books', '📚', 50),
('Food & Groceries', 'food', '🍎', 60),
('Services', 'services', '🛠️', 70),
('Digital Products', 'digital', '💻', 80),
('Art & Collectibles', 'art', '🎨', 90),
('Other', 'other', '📦', 100)
ON CONFLICT (slug) DO UPDATE SET 
  name = EXCLUDED.name,
  icon = EXCLUDED.icon,
  position = EXCLUDED.position;
