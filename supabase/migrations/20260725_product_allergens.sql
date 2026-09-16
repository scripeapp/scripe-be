-- Every kitchen-JSON import so far had allergen data (gluten, shellfish,
-- etc.) but it could only be folded into the free-text description — not
-- filterable or visually distinct, and safety-relevant info shouldn't be
-- buried in prose. NULL/empty = no allergen info provided.
ALTER TABLE products
ADD COLUMN IF NOT EXISTS allergens TEXT[] NULL;
