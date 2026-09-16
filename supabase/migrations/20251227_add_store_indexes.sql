-- Add performance indexes for store tables
-- These indexes improve query performance for common operations

-- Products: frequently filtered by store_id and status
CREATE INDEX IF NOT EXISTS idx_products_store_status ON products(store_id, status);

-- Orders: frequently filtered by store_id and status
CREATE INDEX IF NOT EXISTS idx_store_orders_store_status ON store_orders(store_id, status);

-- Customers: frequently queried by store_id and email
CREATE INDEX IF NOT EXISTS idx_store_customers_store_email ON store_customers(store_id, email);

-- Payment reference lookup for order verification
CREATE INDEX IF NOT EXISTS idx_store_orders_payment_ref ON store_orders(payment_reference);

-- Products: name search
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);

-- Orders: customer name/email search
CREATE INDEX IF NOT EXISTS idx_store_orders_customer_email ON store_orders(customer_email);
