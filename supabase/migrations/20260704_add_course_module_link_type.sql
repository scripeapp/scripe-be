-- Extend the product_module_links type constraint to allow 'course' links.
-- Courses are standalone (circle_id IS NULL, access_type IN ('free', 'paid')).

ALTER TABLE product_module_links
  DROP CONSTRAINT IF EXISTS pml_valid_module_type;

ALTER TABLE product_module_links
  ADD CONSTRAINT pml_valid_module_type CHECK (
    module_type IN ('circle', 'publication', 'form', 'event_type', 'course')
  );
