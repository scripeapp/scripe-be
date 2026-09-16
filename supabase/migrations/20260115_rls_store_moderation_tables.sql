-- ============================================================================
-- RLS Policies for Store & Moderation Tables
-- Created: 2026-01-15
-- ============================================================================

-- ============================================================================
-- 1. STORE_CUSTOMERS - Scoped by store, which is scoped by business
-- ============================================================================
ALTER TABLE store_customers ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any
DROP POLICY IF EXISTS "Store customers business access" ON store_customers;
DROP POLICY IF EXISTS "Store customers insert" ON store_customers;
DROP POLICY IF EXISTS "Store customers update" ON store_customers;
DROP POLICY IF EXISTS "Store customers delete" ON store_customers;

-- Read: Business members can view customers from their stores
CREATE POLICY "Store customers business access" ON store_customers
FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM stores s 
    WHERE s.id = store_customers.store_id 
    AND is_business_member(s.business_id)
  )
);

-- Insert: Business members can add customers to their stores
CREATE POLICY "Store customers insert" ON store_customers
FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM stores s 
    WHERE s.id = store_customers.store_id 
    AND is_business_member(s.business_id)
  )
);

-- Update: Business members can update customers in their stores
CREATE POLICY "Store customers update" ON store_customers
FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM stores s 
    WHERE s.id = store_customers.store_id 
    AND is_business_member(s.business_id)
  )
);

-- Delete: Business members can delete customers from their stores
CREATE POLICY "Store customers delete" ON store_customers
FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM stores s 
    WHERE s.id = store_customers.store_id 
    AND is_business_member(s.business_id)
  )
);

-- ============================================================================
-- 2. STORE_REVIEWS - Scoped by store, which is scoped by business
-- ============================================================================
ALTER TABLE store_reviews ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any
DROP POLICY IF EXISTS "Store reviews public read" ON store_reviews;
DROP POLICY IF EXISTS "Store reviews business manage" ON store_reviews;
DROP POLICY IF EXISTS "Store reviews public insert" ON store_reviews;

-- Read: Anyone can view visible reviews
CREATE POLICY "Store reviews public read" ON store_reviews
FOR SELECT USING (is_visible = true);

-- Insert: Anyone can insert a review (public submission)
CREATE POLICY "Store reviews public insert" ON store_reviews
FOR INSERT WITH CHECK (true);

-- Update/Delete: Only business members can manage reviews on their stores
CREATE POLICY "Store reviews business manage" ON store_reviews
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM stores s 
    WHERE s.id = store_reviews.store_id 
    AND is_business_member(s.business_id)
  )
);

-- ============================================================================
-- 3. MODERATION_REPORTS - Admin & reporter access
-- ============================================================================
ALTER TABLE moderation_reports ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any
DROP POLICY IF EXISTS "Moderation reports admin access" ON moderation_reports;
DROP POLICY IF EXISTS "Moderation reports reporter view" ON moderation_reports;
DROP POLICY IF EXISTS "Moderation reports reporter create" ON moderation_reports;

-- Read: Admins can see all reports
CREATE POLICY "Moderation reports admin access" ON moderation_reports
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM admin_users 
    WHERE admin_users.user_id = auth.uid() 
    AND admin_users.is_active = true
  )
);

-- Read: Users can see their own reports
CREATE POLICY "Moderation reports reporter view" ON moderation_reports
FOR SELECT USING (reporter_id = auth.uid());

-- Insert: Any authenticated user can create a report
CREATE POLICY "Moderation reports reporter create" ON moderation_reports
FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- ============================================================================
-- Note: crm_contacts_unified is a VIEW, not a table, so RLS is not applicable.
-- The underlying tables (store_orders, issued_tickets, subscriptions) should 
-- have their own RLS policies which will automatically apply to the view.
-- ============================================================================

-- ============================================================================
-- Note: moderation_queue is a VIEW built on moderation_reports, so it inherits
-- the RLS policies from moderation_reports.
-- ============================================================================

-- ============================================================================
-- 4. PRODUCT_VARIANTS - Scoped by product -> store -> business
-- ============================================================================
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any
DROP POLICY IF EXISTS "Product variants business access" ON product_variants;

-- All operations: Business members can manage variants for their products
CREATE POLICY "Product variants business access" ON product_variants
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM products p 
    JOIN stores s ON p.store_id = s.id
    WHERE p.id = product_variants.product_id 
    AND is_business_member(s.business_id)
  )
);

-- ============================================================================
-- 5. PRODUCT_VERSIONS - Scoped by product -> store -> business
-- ============================================================================
ALTER TABLE product_versions ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any
DROP POLICY IF EXISTS "Product versions business access" ON product_versions;

-- All operations: Business members can manage versions for their products
CREATE POLICY "Product versions business access" ON product_versions
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM products p 
    JOIN stores s ON p.store_id = s.id
    WHERE p.id = product_versions.product_id 
    AND is_business_member(s.business_id)
  )
);

-- ============================================================================
-- 6. SEGMENT_ACTIVITY - Scoped by segment -> business
-- ============================================================================
ALTER TABLE segment_activity ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any
DROP POLICY IF EXISTS "Segment activity business access" ON segment_activity;

-- All operations: Business members can manage activity for their segments
CREATE POLICY "Segment activity business access" ON segment_activity
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM segments seg 
    WHERE seg.id = segment_activity.segment_id 
    AND is_business_member(seg.business_id)
  )
);
