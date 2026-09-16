-- CRM: Create unified contacts view for auto-populating contacts
-- Migration: 20251228_create_crm_contacts_view.sql

-- ============================================================================
-- Unified CRM Contacts View
-- Aggregates contacts from: Store Orders, Event Attendees, Publication Subscribers
-- Uses deterministic UUIDs based on user_id + email for consistent IDs
-- ============================================================================

CREATE OR REPLACE VIEW crm_contacts_unified AS
SELECT DISTINCT ON (user_id, email)
  -- Generate deterministic UUID from user_id + email (consistent across queries)
  uuid(md5(user_id::text || '::' || email)::text) as id,
  user_id,
  email,
  name,
  phone,
  'marketing' as status,
  source,
  first_contact_at as created_at,
  last_contact_at as updated_at
FROM (
  -- Store customers (from store_orders)
  SELECT 
    stores.user_id,
    store_orders.customer_email as email,
    store_orders.customer_name as name,
    store_orders.customer_phone as phone,
    'store' as source,
    MIN(store_orders.created_at) as first_contact_at,
    MAX(store_orders.created_at) as last_contact_at
  FROM store_orders
  JOIN stores ON store_orders.store_id = stores.id
  WHERE store_orders.customer_email IS NOT NULL
    AND store_orders.customer_email != ''
  GROUP BY stores.user_id, store_orders.customer_email, store_orders.customer_name, store_orders.customer_phone
  
  UNION ALL
  
  -- Event attendees (from issued_tickets)
  SELECT 
    events.owner_id as user_id,
    issued_tickets.customer_email as email,
    issued_tickets.customer_name as name,
    issued_tickets.customer_phone as phone,
    'event' as source,
    MIN(issued_tickets.created_at) as first_contact_at,
    MAX(issued_tickets.created_at) as last_contact_at
  FROM issued_tickets
  JOIN events ON issued_tickets.event_id = events.id
  WHERE issued_tickets.customer_email IS NOT NULL
    AND issued_tickets.customer_email != ''
    AND issued_tickets.customer_email NOT LIKE '%@noemail.local'
  GROUP BY events.owner_id, issued_tickets.customer_email, issued_tickets.customer_name, issued_tickets.customer_phone
  
  UNION ALL
  
  -- Publication subscribers (from subscriptions)
  SELECT 
    publications.user_id,
    users.email,
    users.name,
    NULL as phone,
    'publication' as source,
    MIN(subscriptions.created_at) as first_contact_at,
    MAX(subscriptions.created_at) as last_contact_at
  FROM subscriptions
  JOIN publications ON subscriptions.publication_id = publications.id
  JOIN users ON subscriptions.user_id = users.id
  WHERE users.email IS NOT NULL
    AND users.email != ''
  GROUP BY publications.user_id, users.email, users.name
) combined
ORDER BY user_id, email, last_contact_at DESC;

-- ============================================================================
-- Index for performance on the underlying tables
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_store_orders_customer_email ON store_orders(customer_email);
CREATE INDEX IF NOT EXISTS idx_issued_tickets_customer_email ON issued_tickets(customer_email);
CREATE INDEX IF NOT EXISTS idx_subscriptions_publication_id ON subscriptions(publication_id);
