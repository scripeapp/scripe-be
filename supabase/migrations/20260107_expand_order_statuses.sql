-- Expand order statuses to include 'processing' and more granular shipping states
-- This allows the frontend dashboard to move through the 4 segments correctly

-- 1. Update status check constraint
ALTER TABLE store_orders 
DROP CONSTRAINT IF EXISTS store_orders_status_check;

ALTER TABLE store_orders
ADD CONSTRAINT store_orders_status_check 
CHECK (status IN ('paid', 'processing', 'fulfilled', 'cancelled', 'refunded'));

-- 2. Update shipping_status check constraint
ALTER TABLE store_orders 
DROP CONSTRAINT IF EXISTS store_orders_shipping_status_check;

ALTER TABLE store_orders
ADD CONSTRAINT store_orders_shipping_status_check 
CHECK (shipping_status IN ('pending', 'processing', 'ready_for_pickup', 'shipped', 'delivered'));

-- 3. Update existing 'paid' orders that were recently accepted to 'processing' if needed
-- (Optional, but helps with consistency)
-- UPDATE store_orders SET status = 'processing' WHERE status = 'paid' AND shipping_status = 'pending';
