-- lead_time_hours is currently one value per product, store-wide. Real
-- multi-branch data (Sisi Oge's Ikeja branch needing 48h vs. the default
-- 24h for the same item, due to a smaller kitchen) showed this isn't
-- always true — a branch can genuinely need a different lead time than
-- the product's base value. NULL = use the product's own lead_time_hours.
ALTER TABLE product_branch_overrides
ADD COLUMN IF NOT EXISTS lead_time_hours INTEGER NULL;
