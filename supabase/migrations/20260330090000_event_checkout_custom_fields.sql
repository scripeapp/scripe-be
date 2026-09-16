ALTER TABLE events
ADD COLUMN IF NOT EXISTS checkout_fields JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE issued_tickets
ADD COLUMN IF NOT EXISTS customer_custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;
