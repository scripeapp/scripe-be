-- Decouples "is this a food business" (store_type, content model: Menu/
-- modifiers/allergens) from "does this business sell in person" (this
-- flag: Locations/Registers/Staff/POS/branch-driven storefront features).
-- Food stores already imply a physical location and are unaffected — this
-- only gives General stores (digital sellers, course creators, and
-- physical retailers like pharmacies/boutiques alike) an opt-in path to
-- the same physical-operation machinery, without forcing it on anyone.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS sells_in_person BOOLEAN NOT NULL DEFAULT false;

NOTIFY pgrst, 'reload schema';
