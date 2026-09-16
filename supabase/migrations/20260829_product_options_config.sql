ALTER TABLE products
  ADD COLUMN IF NOT EXISTS options_config JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE products
  ADD CONSTRAINT products_options_config_array
  CHECK (jsonb_typeof(options_config) = 'array');
