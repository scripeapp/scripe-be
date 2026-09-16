-- Per-store toggle for Shipbubble carrier delivery.
-- Default false: carrier rates are opt-in and only shown at checkout once a
-- merchant has enabled it and confirmed a valid (Shipbubble-validatable)
-- business pickup address.

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS carrier_delivery_enabled BOOLEAN NOT NULL DEFAULT false;
