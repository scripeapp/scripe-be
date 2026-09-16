-- Availability Management System for Hilaq
-- Implement centralized availability profiles

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Availability Profiles table
CREATE TABLE IF NOT EXISTS availability_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  description TEXT,
  
  -- Array of objects: { "day": "Monday", "isEnabled": true, "ranges": [{ "startTime": "09:00", "endTime": "17:00" }] }
  weekly_schedule JSONB NOT NULL DEFAULT '[]'::jsonb,
  
  -- Object: { "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD", "blackoutDates": [{ "date": "YYYY-MM-DD", "reason": "Public Holiday" }] }
  date_rules JSONB NOT NULL DEFAULT '{"startDate": null, "endDate": null, "blackoutDates": []}'::jsonb,
  
  -- Object: { "maxPerSlot": number, "maxPerDay": number, "isEnabled": boolean }
  capacity JSONB NOT NULL DEFAULT '{"maxPerSlot": null, "maxPerDay": null, "isEnabled": false}'::jsonb,
  
  timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Update Products table to link to availability profiles
DO $$ 
BEGIN 
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'availability_profile_id') THEN
    ALTER TABLE products ADD COLUMN availability_profile_id UUID REFERENCES availability_profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_availability_profiles_owner_id ON availability_profiles(owner_id);
CREATE INDEX IF NOT EXISTS idx_products_availability_profile_id ON products(availability_profile_id);

-- Trigger to auto-update updated_at timestamp
DROP TRIGGER IF EXISTS availability_profiles_set_updated_at ON availability_profiles;
CREATE TRIGGER availability_profiles_set_updated_at
BEFORE UPDATE ON availability_profiles
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
