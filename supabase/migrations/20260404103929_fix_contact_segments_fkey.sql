-- Migration: Drop contact_segments foreign key to decouple it from manual contacts table
-- This allows `contact_segments` to naturally accept unified synthetic IDs from `crm_contacts_unified`

-- 1. Drop the restrictive foreign key constraint targeting contact_segments -> contacts
ALTER TABLE contact_segments DROP CONSTRAINT IF EXISTS contact_segments_contact_id_fkey;

-- 2. Convert existing manual UUID bindings to their synthetic equivalents, ensuring parity with the unified view logic
UPDATE contact_segments cs
SET contact_id = uuid(md5(c.business_id::text || '::' || LOWER(c.email))::text)
FROM contacts c
WHERE cs.contact_id = c.id;
