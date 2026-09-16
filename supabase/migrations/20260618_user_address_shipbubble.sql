-- Cache Shipbubble validation on saved customer addresses so checkout can
-- reuse a validated address_code instead of re-validating (which costs wallet
-- credits) on every order. lat/lng improve validation accuracy.

ALTER TABLE user_addresses
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS shipbubble_address_code BIGINT;
