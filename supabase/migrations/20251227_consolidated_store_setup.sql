-- Consolidated migration for Store features
-- Created on 2025-12-27

-- 1. Update sub_accounts table (Add missing columns)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sub_accounts' AND column_name = 'currency') THEN
        ALTER TABLE sub_accounts ADD COLUMN currency VARCHAR(3) DEFAULT 'NGN';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sub_accounts' AND column_name = 'updated_at') THEN
        ALTER TABLE sub_accounts ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
        -- Try to backfill updated_at from created_at if it exists, otherwise use NOW()
        -- Note: using dynamic SQL or simple update if column exists
        UPDATE sub_accounts SET updated_at = COALESCE(created_at, NOW());
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sub_accounts_user_id ON sub_accounts(user_id);

-- 2. Create store_customers table
CREATE TABLE IF NOT EXISTS store_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  address TEXT,
  orders_count INTEGER DEFAULT 1,
  lifetime_value DECIMAL(10, 2) DEFAULT 0,
  currency VARCHAR(3) DEFAULT 'NGN',
  first_order_at TIMESTAMPTZ DEFAULT NOW(),
  last_order_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(store_id, email)
);

-- 3. Create Indexes for store_customers
CREATE INDEX IF NOT EXISTS idx_store_customers_store_id ON store_customers(store_id);
CREATE INDEX IF NOT EXISTS idx_store_customers_email ON store_customers(email);

-- 4. Add Performance Indexes for existing tables
CREATE INDEX IF NOT EXISTS idx_products_store_status ON products(store_id, status);
CREATE INDEX IF NOT EXISTS idx_store_orders_store_status ON store_orders(store_id, status);
CREATE INDEX IF NOT EXISTS idx_store_customers_store_email ON store_customers(store_id, email);
CREATE INDEX IF NOT EXISTS idx_store_orders_payment_ref ON store_orders(payment_reference);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_store_orders_customer_email ON store_orders(customer_email);

-- 5. Helper trigger for timestamps (if not already present for new tables)
-- Reuse existing set_updated_at function
DROP TRIGGER IF EXISTS sub_accounts_set_updated_at ON sub_accounts;
CREATE TRIGGER sub_accounts_set_updated_at
BEFORE UPDATE ON sub_accounts
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- Note: Buckets must be created via Dashboard or Storage API usually, 
-- ensuring 'store-assets' bucket exists is a manual step or separate script.
