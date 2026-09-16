-- User Saved Addresses Table
-- Allows authenticated users to store and manage delivery addresses for checkout

-- Create the user_addresses table
CREATE TABLE IF NOT EXISTS user_addresses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- Address metadata
  label VARCHAR(50),                    -- Optional: "Home", "Work", "Office"
  is_default BOOLEAN DEFAULT false,
  
  -- Recipient info
  recipient_name VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  
  -- Address fields
  address_line_1 VARCHAR(255) NOT NULL, -- Street address
  address_line_2 VARCHAR(255),          -- Apt, Suite, Floor (optional)
  city VARCHAR(100) NOT NULL,
  state VARCHAR(100) NOT NULL,
  postal_code VARCHAR(20),              -- Optional for Nigeria
  country VARCHAR(100) DEFAULT 'Nigeria',
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_addresses_user_id ON user_addresses(user_id);
CREATE INDEX IF NOT EXISTS idx_user_addresses_default ON user_addresses(user_id, is_default);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_user_addresses_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_addresses_set_updated_at ON user_addresses;
CREATE TRIGGER user_addresses_set_updated_at
  BEFORE UPDATE ON user_addresses
  FOR EACH ROW
  EXECUTE FUNCTION update_user_addresses_updated_at();

-- Trigger to enforce single default per user
CREATE OR REPLACE FUNCTION enforce_single_default_address()
RETURNS TRIGGER AS $$
BEGIN
  -- Only act if setting is_default to true
  IF NEW.is_default = true THEN
    -- Clear is_default on all other addresses for this user
    UPDATE user_addresses
    SET is_default = false
    WHERE user_id = NEW.user_id
      AND id != NEW.id
      AND is_default = true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_addresses_enforce_single_default ON user_addresses;
CREATE TRIGGER user_addresses_enforce_single_default
  BEFORE INSERT OR UPDATE OF is_default ON user_addresses
  FOR EACH ROW
  WHEN (NEW.is_default = true)
  EXECUTE FUNCTION enforce_single_default_address();

-- RLS Policies
ALTER TABLE user_addresses ENABLE ROW LEVEL SECURITY;

-- Users can only access their own addresses
DROP POLICY IF EXISTS "Users can view their own addresses" ON user_addresses;
CREATE POLICY "Users can view their own addresses" ON user_addresses
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own addresses" ON user_addresses;
CREATE POLICY "Users can insert their own addresses" ON user_addresses
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own addresses" ON user_addresses;
CREATE POLICY "Users can update their own addresses" ON user_addresses
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own addresses" ON user_addresses;
CREATE POLICY "Users can delete their own addresses" ON user_addresses
  FOR DELETE USING (auth.uid() = user_id);
