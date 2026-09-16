-- Hilaq Store tables for Store feature
-- All tables use UUID primary keys and snake_case column naming

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Stores table (one per user)
CREATE TABLE IF NOT EXISTS stores (
  id UUID PRIMARY KEY ,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  registered_business_name VARCHAR(255),
  is_live BOOLEAN DEFAULT FALSE,
  
  -- Appearance settings (JSONB)
  appearance JSONB DEFAULT '{"description": "", "cover_image": null}'::jsonb,
  
  -- Delivery settings (JSONB)
  delivery JSONB DEFAULT '{"default_carrier": "GIG", "enable_tracking": true, "shipping_note": ""}'::jsonb,
  
  -- After purchase settings (JSONB)
  after_purchase JSONB DEFAULT '{"thank_you_message": "Thank you for your purchase! We appreciate your business.", "digital_download_instructions": "Your download link has been sent to your email.", "follow_up_email_note": "A confirmation email will be sent to you shortly with order details."}'::jsonb,
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(user_id)
);

-- Products table
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY ,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'NGN',
  type VARCHAR(20) NOT NULL CHECK (type IN ('digital', 'physical', 'service')),
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('published', 'draft')),
  cover_image TEXT,
  images JSONB DEFAULT '[]'::jsonb,
  stock INTEGER,
  orders_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
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

-- Discount codes table
CREATE TABLE IF NOT EXISTS discount_codes (
  id UUID PRIMARY KEY ,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  code VARCHAR(50) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('percentage', 'fixed')),
  value DECIMAL(10, 2) NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  usage_count INTEGER DEFAULT 0,
  max_usage INTEGER,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(store_id, code)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_stores_user_id ON stores(user_id);
CREATE INDEX IF NOT EXISTS idx_stores_slug ON stores(slug);

-- CREATE INDEX IF NOT EXISTS idx_products_store_id ON products(store_id);
-- CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);

-- CREATE INDEX IF NOT EXISTS idx_orders_store_id ON orders(store_id);
-- CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
-- CREATE INDEX IF NOT EXISTS idx_orders_payment_reference ON orders(payment_reference);

-- CREATE INDEX IF NOT EXISTS idx_discount_codes_store_id ON discount_codes(store_id);
-- CREATE INDEX IF NOT EXISTS idx_discount_codes_code ON discount_codes(code);

-- -- GIN indexes for JSONB columns
-- CREATE INDEX IF NOT EXISTS idx_orders_items_gin ON orders USING gin (items);
-- CREATE INDEX IF NOT EXISTS idx_products_images_gin ON products USING gin (images);
-- CREATE INDEX IF NOT EXISTS idx_stores_appearance_gin ON stores USING gin (appearance);
-- CREATE INDEX IF NOT EXISTS idx_stores_delivery_gin ON stores USING gin (delivery);
-- CREATE INDEX IF NOT EXISTS idx_stores_after_purchase_gin ON stores USING gin (after_purchase);

-- Triggers to auto-update updated_at timestamp
-- Reuse the set_updated_at function from websites migration

DROP TRIGGER IF EXISTS stores_set_updated_at ON stores;
CREATE TRIGGER stores_set_updated_at
BEFORE UPDATE ON stores
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS products_set_updated_at ON products;
CREATE TRIGGER products_set_updated_at
BEFORE UPDATE ON products
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS orders_set_updated_at ON orders;
CREATE TRIGGER orders_set_updated_at
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS discount_codes_set_updated_at ON discount_codes;
CREATE TRIGGER discount_codes_set_updated_at
BEFORE UPDATE ON discount_codes
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
