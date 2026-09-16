-- Migration: 20260625_add_after_purchase_redirect_to_products.sql
-- Description: Adds an optional per-product redirect URL. When set, buyers are
-- sent to this link (e.g. a WhatsApp group) after they successfully pay for the
-- product on the order success page.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS after_purchase_redirect_url TEXT NULL;
