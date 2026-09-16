-- Persist event availability instead of inferring sales channels in the UI.
-- Existing events remain available through the online storefront.

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS sales_channels TEXT[] NOT NULL
  DEFAULT ARRAY['storefront']::TEXT[];

UPDATE public.events
SET sales_channels = ARRAY['storefront']::TEXT[]
WHERE sales_channels IS NULL OR cardinality(sales_channels) = 0;

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_sales_channels_check;

ALTER TABLE public.events
  ADD CONSTRAINT events_sales_channels_check
  CHECK (
    cardinality(sales_channels) > 0
    AND sales_channels <@ ARRAY['storefront', 'pos', 'marketplace']::TEXT[]
  );

COMMENT ON COLUMN public.events.sales_channels IS
  'Configured ticket sales channels: storefront, pos, or marketplace.';
