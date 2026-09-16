-- store_delivery_zones.zip_code was sized for real postal codes (VARCHAR(20)),
-- but stores that key delivery zones by area name (e.g. "Victoria Island
-- (office towers)") can exceed that. Widen to fit descriptive area names.
ALTER TABLE store_delivery_zones ALTER COLUMN zip_code TYPE VARCHAR(60);
