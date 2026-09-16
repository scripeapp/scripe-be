-- Branch-aware storefront, part 2: branch scoping for modifier groups and
-- options. Same null-means-all-branches convention already used by
-- store_menus.branch_ids and products.available_branch_ids.

ALTER TABLE modifier_groups
ADD COLUMN IF NOT EXISTS branch_ids UUID[] NULL;

ALTER TABLE modifier_options
ADD COLUMN IF NOT EXISTS branch_ids UUID[] NULL;
