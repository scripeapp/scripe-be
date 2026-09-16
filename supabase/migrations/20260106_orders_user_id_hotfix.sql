-- HOTFIX: Add user_id column to orders table for ticket history
-- Run this if you already ran the previous migration

DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='user_id') THEN
        ALTER TABLE public.orders ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
        RAISE NOTICE 'Added user_id column to orders table';
    ELSE
        RAISE NOTICE 'user_id column already exists in orders table';
    END IF;
    
    -- Also add created_at if missing (some legacy orders tables use order_date)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='created_at') THEN
        ALTER TABLE public.orders ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW();
        CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
        RAISE NOTICE 'Added created_at column to orders table';
    END IF;
END $$;
