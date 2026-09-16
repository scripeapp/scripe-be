-- Migration: 20260408_add_released_at_to_products.sql
-- Description: Adds a released_at timestamp to products for pre-order audit trail.
-- Captures the exact moment a pre-order product was released (manually or automatically),
-- allowing comparison against pre_order_release_date to see if release was on time.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ NULL;
