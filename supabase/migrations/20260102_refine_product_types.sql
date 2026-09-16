-- Refine product JSONB columns documentation
COMMENT ON COLUMN products.physical IS 'Physical product data: weight (kg), requires_shipping, dimensions {length, width, height} (cm)';
COMMENT ON COLUMN products.digital IS 'Digital product data: download_url, download_limit, file_type';
COMMENT ON COLUMN products.service IS 'Service product data: duration_minutes, location, availability';

-- No structural changes needed as these are JSONB, but this migration serves as a schema checkpoint.
