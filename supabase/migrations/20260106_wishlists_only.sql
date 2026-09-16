-- Migration: Create wishlists table for Marketplace
-- NOTE: We are NOT merging store_orders into orders. They remain separate:
--   - store_orders: Product purchases (store dashboard)
--   - orders: Event tickets

-- 1. Create wishlists table
CREATE TABLE IF NOT EXISTS public.wishlists (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT unique_user_product_wishlist UNIQUE (user_id, product_id)
);

-- 2. RLS Policies for Wishlists
ALTER TABLE public.wishlists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own wishlist" ON public.wishlists;
CREATE POLICY "Users can view their own wishlist" 
ON public.wishlists FOR SELECT 
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage their own wishlist" ON public.wishlists;
CREATE POLICY "Users can manage their own wishlist" 
ON public.wishlists FOR ALL 
USING (auth.uid() = user_id);

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_wishlists_user_id ON wishlists(user_id);
CREATE INDEX IF NOT EXISTS idx_wishlists_product_id ON wishlists(product_id);

-- 4. Add user_id to store_orders if missing (for marketplace order history)
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='store_orders' AND column_name='user_id') THEN
        ALTER TABLE public.store_orders ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_store_orders_user_id ON store_orders(user_id);
    END IF;
END $$;

-- 5. Add user_id to orders (tickets) if missing (for marketplace ticket history)
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='user_id') THEN
        ALTER TABLE public.orders ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
    END IF;
END $$;
