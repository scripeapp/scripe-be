-- Records that a specific product+variant+branch+requested-time combination
-- has already been confirmed to satisfy the product's lead_time_hours rule.
-- Without this, resolveOrderItemPricing re-derives "is this still >= N
-- hours from RIGHT NOW" on every reprice (every ticket edit, plus the final
-- charge) — so picking the earliest valid minute is booby-trapped: any time
-- spent adding more items or walking to the register makes a previously
-- valid slot fail. Caching the validation removes that race: once a slot
-- is confirmed, it stays trusted for a bounded window instead of being
-- raced against the clock on every subsequent check.
CREATE TABLE IF NOT EXISTS pos_lead_time_validations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id UUID REFERENCES product_variants(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES store_branches(id) ON DELETE CASCADE,
  slot_date DATE NOT NULL,
  slot_start_time TEXT NOT NULL,
  validated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pos_lead_time_validations_lookup
  ON pos_lead_time_validations (product_id, slot_date, slot_start_time);

-- Internal bookkeeping table only — read/written exclusively by
-- resolveOrderItemPricing via the service-role client, never exposed
-- through any direct client-facing route. RLS enabled with no policies,
-- matching the rest of the app's backend-only operational tables.
ALTER TABLE pos_lead_time_validations ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
