-- Standalone bookings via "Book now" don't create a store order first;
-- the placeholder zero-UUID causes join failures and reporting noise.
ALTER TABLE service_bookings ALTER COLUMN order_id DROP NOT NULL;
