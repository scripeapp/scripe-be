-- Registers/POS Phase 5: staff PINs. Device pairing (Phase 4b) identifies
-- the TILL; this identifies the PERSON operating it, so sales and
-- shift open/close can be attributed to a specific staff member without
-- that person needing a full dashboard login — matching the same
-- no-dashboard-account principle as device pairing itself.

CREATE TABLE IF NOT EXISTS pos_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- SHA-256(pin + pepper) — see StoreService.hashPosPin. Never plaintext.
  pin_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pos_staff_store ON pos_staff(store_id);

-- A 4-digit PIN must resolve to exactly one person per store. Inactive
-- (former) staff free up their PIN for reuse.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_staff_store_pin_active
  ON pos_staff(store_id, pin_hash)
  WHERE status = 'active';

ALTER TABLE pos_staff ENABLE ROW LEVEL SECURITY;

-- Mirrors registers' business-membership-scoped RLS pattern.
CREATE POLICY "Business members can view pos_staff"
  ON pos_staff
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM stores s
      JOIN memberships m ON m.business_id = s.business_id
      WHERE s.id = pos_staff.store_id
        AND m.user_id = auth.uid()
    )
  );

CREATE POLICY "Business members can create pos_staff"
  ON pos_staff
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM stores s
      JOIN memberships m ON m.business_id = s.business_id
      WHERE s.id = pos_staff.store_id
        AND m.user_id = auth.uid()
    )
  );

CREATE POLICY "Business members can update pos_staff"
  ON pos_staff
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM stores s
      JOIN memberships m ON m.business_id = s.business_id
      WHERE s.id = pos_staff.store_id
        AND m.user_id = auth.uid()
    )
  );

CREATE POLICY "Business members can delete pos_staff"
  ON pos_staff
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM stores s
      JOIN memberships m ON m.business_id = s.business_id
      WHERE s.id = pos_staff.store_id
        AND m.user_id = auth.uid()
    )
  );

COMMENT ON TABLE pos_staff IS 'A till PIN identifying a specific staff member for sale/shift attribution — deliberately not a dashboard login.';

-- ── Attribution columns ──

ALTER TABLE store_orders
ADD COLUMN IF NOT EXISTS staff_id UUID REFERENCES pos_staff(id) ON DELETE SET NULL;

ALTER TABLE register_shifts
ADD COLUMN IF NOT EXISTS opened_by_staff_id UUID REFERENCES pos_staff(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS closed_by_staff_id UUID REFERENCES pos_staff(id) ON DELETE SET NULL;

-- ── Per-store PIN policy — how often /pos re-prompts for a PIN ──

ALTER TABLE stores
ADD COLUMN IF NOT EXISTS pos_pin_mode VARCHAR(20) NOT NULL DEFAULT 'per_sale'
  CHECK (pos_pin_mode IN ('per_sale', 'per_session'));

COMMENT ON COLUMN stores.pos_pin_mode IS 'per_sale: PIN required before every charge. per_session: PIN unlocks the till until "Switch user" or the tab closes.';
