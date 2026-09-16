-- Add buffer_minutes column to availability_profiles table
-- This defines the buffer time between appointments

ALTER TABLE availability_profiles
ADD COLUMN IF NOT EXISTS buffer_minutes INTEGER DEFAULT 0;

COMMENT ON COLUMN availability_profiles.buffer_minutes IS 'Buffer time in minutes between appointments';
