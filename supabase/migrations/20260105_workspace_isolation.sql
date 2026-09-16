-- ============================================================================
-- Workspace Isolation Migration
-- Ensures ALL workspace-level entities are scoped by business_id
-- ============================================================================

-- 1. ADD business_id TO CORE TABLES
ALTER TABLE websites ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE halqahs ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE communication_domains ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE communication_senders ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE availability_profiles ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;

-- 2. BACKFILL business_id FROM OWNERS
-- We use the memberships table to find the user's primary business (Owner role)
DO $$
BEGIN
    -- Backfill Websites
    UPDATE websites w
    SET business_id = m.business_id
    FROM memberships m
    JOIN roles r ON m.role_id = r.id
    WHERE w.user_id = m.user_id AND r.is_owner = true AND w.business_id IS NULL;

    -- Backfill Publications
    UPDATE publications p
    SET business_id = m.business_id
    FROM memberships m
    JOIN roles r ON m.role_id = r.id
    WHERE p.user_id = m.user_id AND r.is_owner = true AND p.business_id IS NULL;

    -- Backfill Events (using owner_id)
    UPDATE events e
    SET business_id = m.business_id
    FROM memberships m
    JOIN roles r ON m.role_id = r.id
    WHERE e.owner_id = m.user_id AND r.is_owner = true AND e.business_id IS NULL;

    -- Backfill Halqahs (assuming it uses user_id or similar - we'll check if it fails)
    -- If halqahs table has unique ownership, join it here.

    -- Backfill CRM & Communications
    UPDATE contacts c SET business_id = m.business_id FROM memberships m JOIN roles r ON m.role_id = r.id WHERE c.user_id = m.user_id AND r.is_owner = true AND c.business_id IS NULL;
    UPDATE segments s SET business_id = m.business_id FROM memberships m JOIN roles r ON m.role_id = r.id WHERE s.user_id = m.user_id AND r.is_owner = true AND s.business_id IS NULL;
    UPDATE campaigns c SET business_id = m.business_id FROM memberships m JOIN roles r ON m.role_id = r.id WHERE c.user_id = m.user_id AND r.is_owner = true AND c.business_id IS NULL;
    UPDATE communication_domains d SET business_id = m.business_id FROM memberships m JOIN roles r ON m.role_id = r.id WHERE d.user_id = m.user_id AND r.is_owner = true AND d.business_id IS NULL;
    UPDATE communication_senders s SET business_id = m.business_id FROM memberships m JOIN roles r ON m.role_id = r.id WHERE s.user_id = m.user_id AND r.is_owner = true AND s.business_id IS NULL;
    UPDATE availability_profiles a SET business_id = m.business_id FROM memberships m JOIN roles r ON m.role_id = r.id WHERE a.owner_id = m.user_id AND r.is_owner = true AND a.business_id IS NULL;
END $$;

-- 3. DROP LEGACY UNIQUE CONSTRAINTS (that only used user_id)
ALTER TABLE websites DROP CONSTRAINT IF EXISTS websites_user_unique;
DROP INDEX IF EXISTS websites_user_unique; -- For the index created in 20251211

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_user_id_email_key;
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_business_id_email_key;
DROP INDEX IF EXISTS contacts_business_id_email_key;
ALTER TABLE contacts ADD CONSTRAINT contacts_business_id_email_key UNIQUE (business_id, email);

ALTER TABLE communication_domains DROP CONSTRAINT IF EXISTS communication_domains_user_id_domain_key;
ALTER TABLE communication_domains DROP CONSTRAINT IF EXISTS communication_domains_business_id_domain_key;
DROP INDEX IF EXISTS communication_domains_business_id_domain_key;
ALTER TABLE communication_domains ADD CONSTRAINT communication_domains_business_id_domain_key UNIQUE (business_id, domain);

-- 4. UPDATE CRM UNIFIED VIEW
-- Redefine view to use business_id for scoping
DROP VIEW IF EXISTS crm_contacts_unified CASCADE;

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
) combined
ORDER BY business_id, email, last_contact_at DESC;

-- 5. ENABLE RLS & CREATE POLICIES (Workspace Isolation)
ALTER TABLE websites ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE halqahs ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_senders ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_profiles ENABLE ROW LEVEL SECURITY;

-- Helper function already exists: is_business_member(uuid)

-- Create universal workspace policy for these tables
DO $$
DECLARE
    t TEXT;
    tables TEXT[] := ARRAY[
        'websites', 'events', 'halqahs', 'contacts', 'segments', 
        'campaigns', 'communication_domains', 'communication_senders', 
        'availability_profiles'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format('DROP POLICY IF EXISTS "Business member access" ON %I', t);
        EXECUTE format('CREATE POLICY "Business member access" ON %I FOR ALL USING (is_business_member(business_id))', t);
    END LOOP;
END $$;
