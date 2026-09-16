-- Create store_orders table (renamed from orders to avoid conflict with events)
CREATE TABLE IF NOT EXISTS store_orders (
  id UUID PRIMARY KEY ,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_number VARCHAR(50) UNIQUE NOT NULL,
  
  -- Customer Info (flat columns for easy querying)
  customer_name VARCHAR(255) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  customer_phone VARCHAR(50),
  customer_address TEXT,
  
  -- Order Details
  items JSONB NOT NULL,
  subtotal DECIMAL(10, 2) NOT NULL,
  discount DECIMAL(10, 2) DEFAULT 0,
  total DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'NGN',
  
  -- Payment
  status VARCHAR(20) DEFAULT 'paid' CHECK (status IN ('paid', 'fulfilled', 'cancelled', 'refunded')),
  payment_reference VARCHAR(255) NOT NULL,
  
  -- Shipping (flat columns for easy querying)
  shipping_carrier VARCHAR(50),
  shipping_tracking_number VARCHAR(255),
  shipping_status VARCHAR(20) CHECK (shipping_status IN ('pending', 'shipped', 'delivered')),
  shipped_at TIMESTAMP,
  delivered_at TIMESTAMP,
  
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  fulfilled_at TIMESTAMP
);

-- Indexes for store_orders
CREATE INDEX IF NOT EXISTS idx_store_orders_store_id ON store_orders(store_id);
CREATE INDEX IF NOT EXISTS idx_store_orders_status ON store_orders(status);
CREATE INDEX IF NOT EXISTS idx_store_orders_payment_reference ON store_orders(payment_reference);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS store_orders_set_updated_at ON store_orders;
CREATE TRIGGER store_orders_set_updated_at
BEFORE UPDATE ON store_orders
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
