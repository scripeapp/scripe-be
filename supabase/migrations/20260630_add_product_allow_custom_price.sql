-- ============================================================================
-- Add "pay what you want" support to products
-- ============================================================================
-- When allow_custom_price is true the buyer enters their own amount at
-- checkout, reusing the same price-resolution path as donation products. The
-- difference is only terminology in the UI (neutral wording, not "donation").
-- ============================================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS allow_custom_price boolean NOT NULL DEFAULT false;
