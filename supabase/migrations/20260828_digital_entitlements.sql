CREATE TABLE IF NOT EXISTS digital_entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES store_orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  first_download_link_issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_digital_entitlements_product
  ON digital_entitlements(product_id);

CREATE OR REPLACE FUNCTION issue_digital_entitlement(
  p_order_id UUID, p_product_id UUID
)
RETURNS TIMESTAMPTZ
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO digital_entitlements (order_id, product_id)
  VALUES (p_order_id, p_product_id)
  ON CONFLICT (order_id, product_id) DO NOTHING
  RETURNING first_download_link_issued_at;
$$;

-- Hardening: atomic issuance always resolves to the FIRST issued timestamp
-- (ON CONFLICT DO NOTHING + RETURNING), so repeat link requests can never
-- reset or extend the buyer's window. Revoke blanket public execution and
-- grant only the roles that legitimately call it.
REVOKE ALL ON FUNCTION public.issue_digital_entitlement(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.issue_digital_entitlement(UUID, UUID)
  TO service_role, authenticated, anon;

REVOKE ALL ON digital_entitlements FROM PUBLIC;
GRANT SELECT, INSERT ON digital_entitlements TO service_role, authenticated;

-- Defense-in-depth RLS. The download service reads/writes via the service
-- role (RLS bypassed), but if any authenticated client ever touches this
-- table it remains confined to its own orders and never reads others'.
ALTER TABLE digital_entitlements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "digital_entitlements_own_orders"
  ON digital_entitlements
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM store_orders so
      WHERE so.id = digital_entitlements.order_id
        AND so.customer_email = (
          SELECT email FROM users u WHERE u.id = auth.uid()
        )
    )
  );
