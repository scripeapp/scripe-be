-- Create store_delivery_methods table
CREATE TABLE IF NOT EXISTS public.store_delivery_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price INTEGER NOT NULL DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'NGN',
  estimated_time VARCHAR(100),
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for efficient querying
CREATE INDEX IF NOT EXISTS idx_delivery_methods_store ON store_delivery_methods(store_id, is_active, sort_order);

-- Create store_delivery_integrations table for future provider integrations
CREATE TABLE IF NOT EXISTS public.store_delivery_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- One integration per provider per store
  CONSTRAINT unique_store_provider UNIQUE(store_id, provider)
);

-- Create index for store_delivery_integrations
CREATE INDEX IF NOT EXISTS idx_delivery_integrations_store ON store_delivery_integrations(store_id);

-- Add delivery columns to store_orders
ALTER TABLE store_orders
ADD COLUMN IF NOT EXISTS delivery_method_id UUID REFERENCES store_delivery_methods(id),
ADD COLUMN IF NOT EXISTS delivery_fee INTEGER DEFAULT 0;
