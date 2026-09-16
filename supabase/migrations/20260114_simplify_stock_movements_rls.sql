-- Simplify RLS on stock_movements now that we have store_id
-- This replaces the complex join with a direct check against store memberships, improving performance and reliability.

DROP POLICY IF EXISTS "Business members can view stock movements" ON stock_movements;
DROP POLICY IF EXISTS "Business members can insert stock movements" ON stock_movements;

CREATE POLICY "Business members can view stock movements"
  ON stock_movements
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM stores s
      JOIN memberships m ON m.business_id = s.business_id
      WHERE s.id = stock_movements.store_id
        AND m.user_id = auth.uid()
    )
  );

CREATE POLICY "Business members can insert stock movements"
  ON stock_movements
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM stores s
      JOIN memberships m ON m.business_id = s.business_id
      WHERE s.id = stock_movements.store_id
        AND m.user_id = auth.uid()
    )
  );
