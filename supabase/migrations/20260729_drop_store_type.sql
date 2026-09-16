-- store_type is fully replaced by sells_in_person (operational) and
-- has_prep_time on products (content model). All application code has
-- been ported off this column in the unified-store-model refactor.
ALTER TABLE stores DROP COLUMN IF EXISTS store_type;
