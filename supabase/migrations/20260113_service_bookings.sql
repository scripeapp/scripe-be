-- Service Bookings Table
-- Stores confirmed service appointments from store orders

CREATE TABLE service_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES store_orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  customer_id UUID,
  customer_email TEXT,
  customer_name TEXT,
  booking_date DATE NOT NULL,
  start_time TEXT NOT NULL, -- HH:mm format
  end_time TEXT NOT NULL,   -- HH:mm format
  status TEXT CHECK (status IN ('confirmed', 'completed', 'cancelled', 'no_show')) DEFAULT 'confirmed',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_service_bookings_store ON service_bookings(store_id);
CREATE INDEX idx_service_bookings_date ON service_bookings(booking_date);
CREATE INDEX idx_service_bookings_order ON service_bookings(order_id);
CREATE INDEX idx_service_bookings_status ON service_bookings(status);
CREATE INDEX idx_service_bookings_store_date ON service_bookings(store_id, booking_date);

-- RLS Policies
ALTER TABLE service_bookings ENABLE ROW LEVEL SECURITY;

-- Store owners can manage their bookings
CREATE POLICY "Store owners can manage bookings"
  ON service_bookings
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM stores s
      JOIN memberships m ON m.business_id = s.business_id
      WHERE s.id = service_bookings.store_id
        AND m.user_id = auth.uid()
    )
  );

-- Public read for customers to view their own bookings
CREATE POLICY "Customers can view own bookings"
  ON service_bookings
  FOR SELECT
  TO authenticated
  USING (customer_id = auth.uid());

COMMENT ON TABLE service_bookings IS 'Stores service appointment bookings linked to orders';
COMMENT ON COLUMN service_bookings.status IS 'confirmed=pending, completed=done, cancelled=cancelled by store/customer, no_show=customer did not show';
