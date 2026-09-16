-- Migration: 20260418_crm_contact_users_rls.sql
-- Allow business members to look up the user records for their own contacts.
--
-- Problem: The CRM contact details endpoint needs to find a contact's user_id
-- from their email in order to fetch their subscriptions. Without this policy,
-- the query returns null (RLS hides other users' rows) so subscription data
-- never loads on the contact details page.
--
-- This policy is safe: it only grants SELECT access to users whose email is
-- already stored in the business's contacts list — the email is already visible
-- to the business member in the CRM.

DROP POLICY IF EXISTS "Business members can look up their contact users" ON users;

CREATE POLICY "Business members can look up their contact users" ON users
FOR SELECT USING (
  EXISTS (
    SELECT 1
    FROM contacts c
    WHERE LOWER(TRIM(c.email)) = LOWER(TRIM(users.email))
      AND is_business_member(c.business_id)
  )
);
