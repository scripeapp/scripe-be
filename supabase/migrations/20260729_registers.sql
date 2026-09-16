-- Registers/POS Phase 4 (registers-prd-full.md): named register devices —
-- upgrades the "one implicit register per branch" MVP (register_shifts
-- alone) to a real registers table, so a branch can run several tills
-- concurrently (e.g. two POS stations at the same counter), each with its
-- own name/device type/status, matching how merchants actually run a floor.

CREATE TABLE IF NOT EXISTS registers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  -- Nullable: a register can be created before it's assigned to a branch
  -- (mirrors the "pair later" flow merchants expect).
  branch_id UUID REFERENCES store_branches(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  device_type TEXT CHECK (device_type IN ('web', 'android', 'ios', 'pos_terminal')),
  register_version TEXT,
  status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('active', 'inactive')),
  paired_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_registers_store ON registers(store_id);
CREATE INDEX IF NOT EXISTS idx_registers_branch ON registers(branch_id);

ALTER TABLE registers ENABLE ROW LEVEL SECURITY;

-- Joined via store_id (not branch_id, which is nullable) so an unpaired
-- register is still visible/manageable by the business that owns it.
CREATE POLICY "Business members can view registers"
  ON registers
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM stores s
      JOIN memberships m ON m.business_id = s.business_id
      WHERE s.id = registers.store_id
        AND m.user_id = auth.uid()
    )
  );

CREATE POLICY "Business members can create registers"
  ON registers
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM stores s
      JOIN memberships m ON m.business_id = s.business_id
      WHERE s.id = registers.store_id
        AND m.user_id = auth.uid()
    )
  );

CREATE POLICY "Business members can update registers"
  ON registers
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM stores s
      JOIN memberships m ON m.business_id = s.business_id
      WHERE s.id = registers.store_id
        AND m.user_id = auth.uid()
    )
  );

CREATE POLICY "Business members can delete registers"
  ON registers
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM stores s
      JOIN memberships m ON m.business_id = s.business_id
      WHERE s.id = registers.store_id
        AND m.user_id = auth.uid()
    )
  );

COMMENT ON TABLE registers IS 'A named till device (web/Android/iOS/terminal) a branch checks out for a POS station — the entity register_shifts now attaches to.';

-- ── register_shifts: attach to a specific register, not just a branch ──

ALTER TABLE register_shifts
ADD COLUMN IF NOT EXISTS register_id UUID REFERENCES registers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_register_shifts_register ON register_shifts(register_id);

-- Superseded: multiple registers can now be open concurrently at the same
-- branch (e.g. two till stations), so "one open shift per branch" is no
-- longer the right constraint.
DROP INDEX IF EXISTS idx_register_shifts_one_open_per_branch;

-- At most one OPEN shift per register at a time. NULL register_id (legacy
-- branch-only shifts, or a shift opened before registers existed) is
-- exempt — Postgres unique indexes already treat NULLs as distinct, but
-- being explicit here documents the intent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_register_shifts_one_open_per_register
  ON register_shifts(register_id)
  WHERE status = 'open' AND register_id IS NOT NULL;
