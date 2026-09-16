-- Add extended product type columns
ALTER TABLE products 
ADD COLUMN IF NOT EXISTS course JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS ebook JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS membership JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS bundle JSONB DEFAULT '{}'::jsonb;

-- Comment on columns for documentation
COMMENT ON COLUMN products.course IS 'Course-specific data: modules, lessons_count, cohort_start_date, is_cohort_based';
COMMENT ON COLUMN products.ebook IS 'E-book specific data: format, has_sample, sample_url, page_count';
COMMENT ON COLUMN products.membership IS 'Membership data: billing_cycle, tier_name, benefits, renewal_reminder_days';
COMMENT ON COLUMN products.bundle IS 'Bundle data: pricing_mode, discount_percentage, product_ids';
