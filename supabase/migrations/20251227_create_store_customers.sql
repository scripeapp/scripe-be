-- Create store_customers table for tracking customer data from orders
-- Customers are auto-created/updated when orders are placed

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

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_store_customers_store_id ON store_customers(store_id);
CREATE INDEX IF NOT EXISTS idx_store_customers_email ON store_customers(email);

-- Trigger for updated_at (reuse existing set_updated_at function)
-- Note: store_customers doesn't have updated_at, uses last_order_at instead
