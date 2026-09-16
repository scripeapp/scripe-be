-- Migration: 20260211_deep_fix_crm_sources.sql
-- Refine source attribution by checking metadata and ensuring cross-platform alignment

-- 1. DROP VIEW IF EXISTS
DROP VIEW IF EXISTS crm_contacts_unified CASCADE;

-- 2. CREATE REFINED VIEW
CREATE OR REPLACE VIEW crm_contacts_unified AS
SELECT DISTINCT ON (business_id, email_normalized)
  uuid(md5(business_id::text || '::' || email_normalized)::text) as id,
  business_id,
  email_original as email,
  name,
  phone,
  'marketing' as status,
  source,
  first_contact_at as created_at,
  last_contact_at as updated_at,
  priority
FROM (
  -- 1. Store customers (Priority 1)
  SELECT 
    stores.business_id,
    LOWER(TRIM(store_orders.customer_email)) as email_normalized,
    store_orders.customer_email as email_original,
    store_orders.customer_name as name,
    store_orders.customer_phone as phone,
    'store' as source,
    MIN(store_orders.created_at) as first_contact_at,
    MAX(store_orders.created_at) as last_contact_at,
    1 as priority
  FROM store_orders
  JOIN stores ON store_orders.store_id = stores.id
  WHERE store_orders.customer_email IS NOT NULL AND TRIM(store_orders.customer_email) != ''
  GROUP BY stores.business_id, LOWER(TRIM(store_orders.customer_email)), store_orders.customer_email, store_orders.customer_name, store_orders.customer_phone
  
  UNION ALL
  
  -- 2. Event attendees (Priority 2)
  SELECT 
    events.business_id,
    LOWER(TRIM(issued_tickets.customer_email)) as email_normalized,
    issued_tickets.customer_email as email_original,
    issued_tickets.customer_name as name,
    issued_tickets.customer_phone as phone,
    'event' as source,
    MIN(issued_tickets.created_at) as first_contact_at,
    MAX(issued_tickets.created_at) as last_contact_at,
    2 as priority
  FROM issued_tickets
  JOIN events ON issued_tickets.event_id = events.id
  WHERE issued_tickets.customer_email IS NOT NULL AND TRIM(issued_tickets.customer_email) != ''
  GROUP BY events.business_id, LOWER(TRIM(issued_tickets.customer_email)), issued_tickets.customer_email, issued_tickets.customer_name, issued_tickets.customer_phone
  
  UNION ALL

  -- 3. Circle members (Priority 3)
  SELECT 
    circles.business_id,
    LOWER(TRIM(users.email)) as email_normalized,
    users.email as email_original,
    users.name as name,
    NULL as phone,
    'circle' as source,
    MIN(circle_members.joined_at) as first_contact_at,
    MAX(circle_members.joined_at) as last_contact_at,
    3 as priority
  FROM circle_members
  JOIN circles ON circle_members.circle_id = circles.id
  JOIN users ON circle_members.user_id = users.id
  WHERE users.email IS NOT NULL AND TRIM(users.email) != ''
  GROUP BY circles.business_id, LOWER(TRIM(users.email)), users.email, users.name
  
  UNION ALL
  
  -- 4. Publication subscribers (Priority 4)
  SELECT 
    publications.business_id,
    LOWER(TRIM(users.email)) as email_normalized,
    users.email as email_original,
    users.name as name,
    NULL as phone,
    'publication' as source,
    MIN(subscriptions.subscribed_at) as first_contact_at,
    MAX(subscriptions.subscribed_at) as last_contact_at,
    4 as priority
  FROM subscriptions
  JOIN publications ON subscriptions.publication_id = publications.id
  JOIN users ON subscriptions.user_id = users.id
  WHERE users.email IS NOT NULL AND TRIM(users.email) != ''
  GROUP BY publications.business_id, LOWER(TRIM(users.email)), users.email, users.name

  UNION ALL

  -- 5. Manual/Other Contacts records (Priority 5 or inferred)
  SELECT
    contacts.business_id,
    LOWER(TRIM(contacts.email)) as email_normalized,
    contacts.email as email_original,
    contacts.name as name,
    contacts.phone as phone,
    COALESCE(contacts.metadata->>'source', 'manual') as source,
    contacts.created_at as first_contact_at,
    contacts.updated_at as last_contact_at,
    CASE 
      WHEN contacts.metadata->>'source' = 'store' THEN 1
      WHEN contacts.metadata->>'source' = 'event' THEN 2
      WHEN contacts.metadata->>'source' = 'circle' THEN 3
      WHEN contacts.metadata->>'source' = 'publication' THEN 4
      ELSE 5
    END as priority
  FROM contacts
  WHERE contacts.business_id IS NOT NULL 
    AND contacts.email IS NOT NULL 
    AND TRIM(contacts.email) != ''
) combined
ORDER BY business_id, email_normalized, priority ASC, last_contact_at DESC;

-- 3. GRANT ACCESS
GRANT SELECT ON crm_contacts_unified TO authenticated;
GRANT SELECT ON crm_contacts_unified TO service_role;
