-- Per-fulfillment-type service charge (e.g. 10% added on top of tax for
-- dine-in only, 0% for takeout/delivery). Stored as a JSON map keyed by
-- fulfillment type, percentages 0-100. Null/absent key = no service charge
-- for that fulfillment type.

ALTER TABLE store_branches
ADD COLUMN IF NOT EXISTS service_charge_rates JSONB NULL;

ALTER TABLE store_orders
ADD COLUMN IF NOT EXISTS service_charge_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
