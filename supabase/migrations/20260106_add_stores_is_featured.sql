-- Add is_featured column to stores table for marketplace featured stores
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT FALSE;

-- Create index for faster featured store queries
CREATE INDEX IF NOT EXISTS idx_stores_is_featured ON stores(is_featured) WHERE is_featured = TRUE;
