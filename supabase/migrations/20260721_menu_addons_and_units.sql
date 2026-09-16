-- Food Store menu restructure: modifier_groups gain a `kind` discriminator
-- so the same reusable-groups infrastructure serves both "Modifiers"
-- (required/optional choice groups, e.g. "Choose your protein") and
-- "Add-ons" (optional extra items with their own price, e.g. "Add fries") —
-- shared store-wide across all menus, matching the existing scope decision.
ALTER TABLE modifier_groups
ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'modifier'
  CHECK (kind IN ('modifier', 'addon'));

CREATE INDEX IF NOT EXISTS idx_modifier_groups_kind ON modifier_groups(store_id, kind);

-- Merchant-defined unit-of-sale vocabulary (piece/kg/liter/pack/...) used to
-- populate the Units tab and the product unit_of_sale field's options.
ALTER TABLE stores
ADD COLUMN IF NOT EXISTS custom_units TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
