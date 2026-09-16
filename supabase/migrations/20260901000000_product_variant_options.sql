-- Multi-option variants: let a variant row carry more than one axis at once
-- (e.g. Size AND Spice Level simultaneously), instead of being limited to the
-- single scalar `group_name` string. Each entry is `{name, value}` — one per
-- axis that combination belongs to. `group_name`/`name` are left untouched
-- for backward compatibility with existing single-axis variants and any
-- reader not yet updated to look at `options`.
--
-- JSONB array on the row itself (not a new join table) matches this
-- codebase's own established convention for this shape of data — see
-- 20260729_collapse_food_store_tables.sql, which deliberately collapsed a
-- normalized `modifier_options` table into a JSONB `options` column on
-- `modifier_groups` for the same reason.

BEGIN;

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
