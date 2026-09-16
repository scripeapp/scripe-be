-- Registers/POS Phase 5c: scope a staff PIN to a branch, same as registers
-- themselves. NULL means "works at any branch" (e.g. a manager who floats
-- between locations) — deliberately not required, to avoid breaking
-- single-branch stores or staff who genuinely work everywhere.

ALTER TABLE pos_staff
ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES store_branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pos_staff_branch ON pos_staff(branch_id);

COMMENT ON COLUMN pos_staff.branch_id IS 'NULL = this staff member''s PIN works at any branch of the store.';
