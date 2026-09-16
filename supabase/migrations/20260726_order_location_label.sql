-- Snapshot the QR code's label onto the order at creation time (same
-- pattern as product_name being copied onto order items rather than
-- live-joined) so a merchant later renaming or deactivating/deleting the
-- QR code never rewrites or blanks out historical orders.
--
-- qr_code_id is stored as a plain UUID referencing the id field inside the
-- store_branches.qr_codes JSONB array (no separate table — QR codes are
-- managed as JSONB on store_branches, not a dedicated relation).
ALTER TABLE store_orders
  ADD COLUMN IF NOT EXISTS qr_code_id UUID NULL,
  ADD COLUMN IF NOT EXISTS location_label VARCHAR(100) NULL;

CREATE INDEX IF NOT EXISTS idx_store_orders_qr_code ON store_orders(qr_code_id);
