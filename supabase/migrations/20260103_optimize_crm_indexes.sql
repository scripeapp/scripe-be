-- Optimize CRM performance
-- Migration: 20260103_optimize_crm_indexes.sql

-- Index for issued_tickets(event_id) to speed up crm_contacts_unified view joins
CREATE INDEX IF NOT EXISTS idx_issued_tickets_event_id ON issued_tickets(event_id);

-- Ensure store_orders(store_id) index exists (idempotent)
CREATE INDEX IF NOT EXISTS idx_store_orders_store_id ON store_orders(store_id);
