-- Fix RLS policies for service_bookings table
-- Allow inserts from authenticated users (for backend operations)

-- First, check if RLS is enabled
ALTER TABLE service_bookings ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to recreate them properly
DROP POLICY IF EXISTS "service_bookings_select" ON service_bookings;
DROP POLICY IF EXISTS "service_bookings_insert" ON service_bookings;
DROP POLICY IF EXISTS "service_bookings_update" ON service_bookings;
DROP POLICY IF EXISTS "service_bookings_delete" ON service_bookings;
DROP POLICY IF EXISTS "Store owners can manage bookings" ON service_bookings; -- Drop old named policy just in case

-- Allow SELECT for:
-- 1. Store Owners (direct ownership)
-- 2. Staff Members (via business membership)
-- 3. Customers (view own bookings)
-- 4. Service Role (backend/admin)
CREATE POLICY "service_bookings_select" ON service_bookings
  FOR SELECT
  USING (
    -- Service Role
    auth.role() = 'service_role'
    OR
    -- Customer accessing their own booking
    auth.uid() = customer_id::uuid
    OR
    -- Store Owner or Staff Member
    EXISTS (
      SELECT 1 FROM stores s
      WHERE s.id = service_bookings.store_id
      AND (
        -- Is Owner
        s.user_id = auth.uid()
        OR
        -- Is Staff Member
        EXISTS (
          SELECT 1 FROM memberships m
          WHERE m.business_id = s.business_id
          AND m.user_id = auth.uid()
          AND m.status = 'active'
        )
      )
    )
  );

-- Allow INSERT for authenticated users
-- Backend typically creates bookings, but if done from client, ensure it's valid.
-- For now, we keep it broad for authenticated users to create bookings (as customers), 
-- OR stricter if only backend should trigger. 
-- The previous file allowed auth users broadly, effectively allowing customers to "book".
CREATE POLICY "service_bookings_insert" ON service_bookings
  FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
    OR auth.role() = 'service_role'
  );

-- Allow UPDATE for Store Owners and Staff
CREATE POLICY "service_bookings_update" ON service_bookings
  FOR UPDATE
  USING (
    -- Service Role
    auth.role() = 'service_role'
    OR
    -- Store Owner or Staff Member
    EXISTS (
      SELECT 1 FROM stores s
      WHERE s.id = service_bookings.store_id
      AND (
        -- Is Owner
        s.user_id = auth.uid()
        OR
        -- Is Staff Member
        EXISTS (
          SELECT 1 FROM memberships m
          WHERE m.business_id = s.business_id
          AND m.user_id = auth.uid()
          AND m.status = 'active'
        )
      )
    )
  );

-- Allow DELETE for Store Owners and Staff
CREATE POLICY "service_bookings_delete" ON service_bookings
  FOR DELETE
  USING (
    -- Service Role
    auth.role() = 'service_role'
    OR
    -- Store Owner or Staff Member
    EXISTS (
      SELECT 1 FROM stores s
      WHERE s.id = service_bookings.store_id
      AND (
        -- Is Owner
        s.user_id = auth.uid()
        OR
        -- Is Staff Member
        EXISTS (
          SELECT 1 FROM memberships m
          WHERE m.business_id = s.business_id
          AND m.user_id = auth.uid()
          AND m.status = 'active'
        )
      )
    )
  );
