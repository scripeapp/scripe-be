-- Backfill existing businesses with categories based on name keywords

DO $$
BEGIN
  -- 1. Retail: Clothing (Boutique, Wear, Fashion, Cloth)
  UPDATE businesses 
  SET category_slug = 'retail', sub_category_slug = 'clothing'
  WHERE category_slug IS NULL 
  AND (name ILIKE '%boutique%' OR name ILIKE '%fashion%' OR name ILIKE '%wear%' OR name ILIKE '%clothing%');

  -- 2. Food: Restaurant/Cafe/Bakery (Kitchen, Food, Cafe, Bakery, Resto)
  UPDATE businesses 
  SET category_slug = 'food_beverage', sub_category_slug = 'restaurant'
  WHERE category_slug IS NULL 
  AND (name ILIKE '%kitchen%' OR name ILIKE '%restaurant%' OR name ILIKE '%diner%' OR name ILIKE '%bistro%');

  UPDATE businesses 
  SET category_slug = 'food_beverage', sub_category_slug = 'cafe'
  WHERE category_slug IS NULL 
  AND (name ILIKE '%cafe%' OR name ILIKE '%coffee%');

  UPDATE businesses 
  SET category_slug = 'food_beverage', sub_category_slug = 'bakery'
  WHERE category_slug IS NULL 
  AND (name ILIKE '%bakery%' OR name ILIKE '%cakes%' OR name ILIKE '%sweets%');

  -- 3. Services: Consulting/Agency
  UPDATE businesses 
  SET category_slug = 'services', sub_category_slug = 'consulting'
  WHERE category_slug IS NULL 
  AND (name ILIKE '%consult%' OR name ILIKE '%agency%' OR name ILIKE '%advisory%');

  -- 4. Digital: Software/Tech
  UPDATE businesses 
  SET category_slug = 'digital_products', sub_category_slug = 'software'
  WHERE category_slug IS NULL 
  AND (name ILIKE '%tech%' OR name ILIKE '%soft%' OR name ILIKE '%digital%' OR name ILIKE '%labs%');

  -- 5. Retail: General (Store, Shop, Mart) -> Other Retail
  UPDATE businesses 
  SET category_slug = 'retail', sub_category_slug = 'other_retail'
  WHERE category_slug IS NULL 
  AND (name ILIKE '%store%' OR name ILIKE '%shop%' OR name ILIKE '%mart%');

  -- 6. Default everything else to Other / Other
  UPDATE businesses 
  SET category_slug = 'other', sub_category_slug = 'other_misc'
  WHERE category_slug IS NULL;

END $$;
