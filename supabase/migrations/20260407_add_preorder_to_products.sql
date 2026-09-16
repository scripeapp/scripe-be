-- Migration: 20260407_add_preorder_to_products.sql
-- Description: Adds pre-order support to digital and eBook products.
-- Creators can mark a product as a pre-order, set a release date, and control
-- whether buyers pay in full or just a deposit up front.

BEGIN;

-- 1. Add pre-order columns to products table
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_pre_order         BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pre_order_release_date TIMESTAMPTZ  NULL,
  ADD COLUMN IF NOT EXISTS pre_order_message     TEXT          NULL,
  ADD COLUMN IF NOT EXISTS pre_order_deposit_pct SMALLINT      NULL
    CONSTRAINT pre_order_deposit_pct_range CHECK (pre_order_deposit_pct BETWEEN 1 AND 100);

-- 2. Add a dedicated pre-order status to store_orders
--    Existing constraint name varies by project; we drop/recreate safely.
DO $$
BEGIN
  -- Drop the existing status check constraint if it exists
  ALTER TABLE store_orders DROP CONSTRAINT IF EXISTS store_orders_status_check;
  ALTER TABLE store_orders DROP CONSTRAINT IF EXISTS orders_status_check;
EXCEPTION WHEN others THEN
  NULL;
END $$;

ALTER TABLE store_orders
  ADD CONSTRAINT store_orders_status_check
  CHECK (status IN (
    'pre_order',   -- paid deposit / full pre-order payment, awaiting release
    'paid',
    'processing',
    'fulfilled',
    'cancelled',
    'refunded'
  ));

-- 3. Index for quick look-up of all pre-order products per store
CREATE INDEX IF NOT EXISTS idx_products_is_pre_order
  ON products (store_id, is_pre_order)
  WHERE is_pre_order = TRUE;

-- 4. Index to find orders that need fulfilment when a product releases
CREATE INDEX IF NOT EXISTS idx_store_orders_pre_order_status
  ON store_orders (status)
  WHERE status = 'pre_order';

COMMIT;
