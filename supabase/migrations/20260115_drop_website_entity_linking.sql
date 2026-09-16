-- Drop Website Entity Linking Tables
-- These tables are no longer being used and can be safely removed

-- Drop indexes first
DROP INDEX IF EXISTS idx_website_linked_stores_store;
DROP INDEX IF EXISTS idx_website_linked_stores_primary;
DROP INDEX IF EXISTS idx_website_linked_events_event;
DROP INDEX IF EXISTS idx_website_linked_halqahs_halqah;
DROP INDEX IF EXISTS idx_website_linked_publications_pub;

-- Drop tables
DROP TABLE IF EXISTS website_linked_stores;
DROP TABLE IF EXISTS website_linked_events;
DROP TABLE IF EXISTS website_linked_halqahs;
DROP TABLE IF EXISTS website_linked_publications;
