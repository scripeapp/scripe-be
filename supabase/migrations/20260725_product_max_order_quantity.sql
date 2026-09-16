-- min_order_quantity/quantity_step already exist but have no upper bound —
-- nothing stops a customer ordering an absurd quantity of a bulk/catering
-- item. Add the missing ceiling; NULL means no cap (default, matches how
-- min_order_quantity/quantity_step were introduced).
ALTER TABLE products
ADD COLUMN IF NOT EXISTS max_order_quantity DECIMAL(10, 3) NULL;
