-- Branch-aware storefront, part 3: branch tax rate + informational
-- manager/format fields, and a tax_amount column on orders to record the
-- computed tax at checkout time.

ALTER TABLE store_branches
ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS manager VARCHAR(255) NULL,
ADD COLUMN IF NOT EXISTS format VARCHAR(50) NULL;

-- Existing rows all get the DEFAULT 0 backfill above before this CHECK is
-- evaluated, so a direct ADD CONSTRAINT (no NOT VALID/VALIDATE dance) is
-- safe here — nothing can already violate it. Still wrapped for idempotency
-- in case this migration is pasted more than once.
DO $$
BEGIN
  ALTER TABLE store_branches DROP CONSTRAINT IF EXISTS store_branches_tax_rate_check;
  ALTER TABLE store_branches
    ADD CONSTRAINT store_branches_tax_rate_check CHECK (tax_rate >= 0 AND tax_rate <= 100);
END $$;

ALTER TABLE store_orders
ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
