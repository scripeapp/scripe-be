-- RLS for the stock counts & branch-to-branch stock transfer tables.
--
-- These four tables carry business inventory data but shipped without any
-- row-level-security policies, so in an environment with RLS enabled every
-- authenticated INSERT was rejected with "new row violates row-level security
-- policy". Scope access to the owning business via stores → is_business_member,
-- mirroring the existing store + product inventory policies.

-- ============================================================================
-- stock_counts — scope by store → business
-- ============================================================================
ALTER TABLE stock_counts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Stock counts business access" ON stock_counts;
CREATE POLICY "Stock counts business access" ON stock_counts
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM stores s
      WHERE s.id = stock_counts.store_id
        AND is_business_member(s.business_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM stores s
      WHERE s.id = stock_counts.store_id
        AND is_business_member(s.business_id)
    )
  );

-- ============================================================================
-- stock_count_lines — scope through its count header
-- ============================================================================
ALTER TABLE stock_count_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Stock count lines business access" ON stock_count_lines;
CREATE POLICY "Stock count lines business access" ON stock_count_lines
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM stock_counts c
      JOIN stores s ON s.id = c.store_id
      WHERE c.id = stock_count_lines.count_id
        AND is_business_member(s.business_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM stock_counts c
      JOIN stores s ON s.id = c.store_id
      WHERE c.id = stock_count_lines.count_id
        AND is_business_member(s.business_id)
    )
  );

-- ============================================================================
-- stock_transfers — scope by store → business
-- ============================================================================
ALTER TABLE stock_transfers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Stock transfers business access" ON stock_transfers;
CREATE POLICY "Stock transfers business access" ON stock_transfers
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM stores s
      WHERE s.id = stock_transfers.store_id
        AND is_business_member(s.business_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM stores s
      WHERE s.id = stock_transfers.store_id
        AND is_business_member(s.business_id)
    )
  );

-- ============================================================================
-- stock_transfer_lines — scope through its transfer header
-- ============================================================================
ALTER TABLE stock_transfer_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Stock transfer lines business access" ON stock_transfer_lines;
CREATE POLICY "Stock transfer lines business access" ON stock_transfer_lines
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM stock_transfers t
      JOIN stores s ON s.id = t.store_id
      WHERE t.id = stock_transfer_lines.transfer_id
        AND is_business_member(s.business_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM stock_transfers t
      JOIN stores s ON s.id = t.store_id
      WHERE t.id = stock_transfer_lines.transfer_id
        AND is_business_member(s.business_id)
    )
  );