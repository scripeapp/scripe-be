-- Minimum advance-notice (lead time) required before a product can be
-- picked up/delivered — e.g. 48 hours for a bulk catering order. Enforced
-- at checkout against the customer-provided slot date/time. Null = no
-- lead time required (the default for all existing products).

ALTER TABLE products
ADD COLUMN IF NOT EXISTS lead_time_hours INTEGER NULL;
