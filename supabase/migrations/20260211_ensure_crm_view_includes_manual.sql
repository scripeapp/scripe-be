-- Migration: 20260211_ensure_crm_view_includes_manual.sql
-- Force update of CRM View to ensure Manual Contacts from 'contacts' table are included

-- 1. DROP VIEW IF EXISTS (to be safe/clean)
DROP VIEW IF EXISTS crm_contacts_unified CASCADE;

-- 2. RECREATE VIEW with 'contacts' table union
CREATE OR REPLACE VIEW crm_contacts_unified AS
SELECT DISTINCT ON (business_id, email)
  uuid(md5(business_id::text || '::' || email)::text) as id,
  business_id,
  email,
  name,
  phone,
  'marketing' as status,
  source,
  first_contact_at as created_at,
  last_contact_at as updated_at
FROM (
  -- Store customers
  SELECT 
    stores.business_id,
    store_orders.customer_email as email,
    store_orders.customer_name as name,
    store_orders.customer_phone as phone,
    'store' as source,
    MIN(store_orders.created_at) as first_contact_at,
    MAX(store_orders.created_at) as last_contact_at
  FROM store_orders
  JOIN stores ON store_orders.store_id = stores.id
  GROUP BY stores.business_id, store_orders.customer_email, store_orders.customer_name, store_orders.customer_phone
  
  UNION ALL
  
  -- Event attendees
  SELECT 
    events.business_id,
    issued_tickets.customer_email as email,
    issued_tickets.customer_name as name,
    issued_tickets.customer_phone as phone,
    'event' as source,
    MIN(issued_tickets.created_at) as first_contact_at,
    MAX(issued_tickets.created_at) as last_contact_at
  FROM issued_tickets
  JOIN events ON issued_tickets.event_id = events.id
  GROUP BY events.business_id, issued_tickets.customer_email, issued_tickets.customer_name, issued_tickets.customer_phone
  
  UNION ALL
  
  -- Publication subscribers
  SELECT 
    publications.business_id,
    users.email,
    users.name,
    NULL as phone,
    'publication' as source,
    MIN(subscriptions.subscribed_at) as first_contact_at,
    MAX(subscriptions.subscribed_at) as last_contact_at
  FROM subscriptions
  JOIN publications ON subscriptions.publication_id = publications.id
  JOIN users ON subscriptions.user_id = users.id
  GROUP BY publications.business_id, users.email, users.name

  UNION ALL

  -- Circle members
  SELECT 
    circles.business_id,
    users.email,
    users.name,
    NULL as phone,
    'circle' as source,
    MIN(circle_members.joined_at) as first_contact_at,
    MAX(circle_members.joined_at) as last_contact_at
  FROM circle_members
  JOIN circles ON circle_members.circle_id = circles.id
  JOIN users ON circle_members.user_id = users.id
  GROUP BY circles.business_id, users.email, users.name

  UNION ALL

  -- Manual Contacts (Explicitly from contacts table)
  SELECT
    contacts.business_id,
    contacts.email,
    contacts.name,
    contacts.phone,
    'manual' as source,
    contacts.created_at as first_contact_at,
    contacts.updated_at as last_contact_at
  FROM contacts
  WHERE contacts.business_id IS NOT NULL 
    AND contacts.email IS NOT NULL 
    AND contacts.email != ''
) combined
ORDER BY business_id, email, last_contact_at DESC;

-- 3. GRANT ACCESS
GRANT SELECT ON crm_contacts_unified TO authenticated;
GRANT SELECT ON crm_contacts_unified TO service_role;
