-- ============================================================================
-- ADD MISSING PERMISSIONS
-- Adds permissions for Events, CRM, Availability, Communications, Website
-- ============================================================================

-- Phase 1: Insert new permissions
INSERT INTO permissions (key, category, description) VALUES
-- Events
('event.create', 'event', 'Create events'),
('event.read', 'event', 'View events'),
('event.update', 'event', 'Edit events'),
('event.delete', 'event', 'Delete events'),
('event.attendee.read', 'event', 'View attendees'),
('event.attendee.checkin', 'event', 'Check in attendees'),
('event.order.create', 'event', 'Create manual orders'),

-- CRM
('crm.contact.read', 'crm', 'View contacts'),
('crm.contact.create', 'crm', 'Create contacts'),
('crm.contact.update', 'crm', 'Edit contacts'),
('crm.contact.delete', 'crm', 'Delete contacts'),
('crm.segment.read', 'crm', 'View segments'),
('crm.segment.create', 'crm', 'Create segments'),
('crm.segment.update', 'crm', 'Edit segments'),
('crm.segment.delete', 'crm', 'Delete segments'),
('crm.campaign.read', 'crm', 'View campaigns'),
('crm.campaign.create', 'crm', 'Create campaigns'),
('crm.campaign.update', 'crm', 'Edit campaigns'),
('crm.campaign.delete', 'crm', 'Delete campaigns'),
('crm.campaign.send', 'crm', 'Send campaigns'),

-- Availability
('availability.read', 'availability', 'View availability profiles'),
('availability.create', 'availability', 'Create availability profiles'),
('availability.update', 'availability', 'Edit availability profiles'),
('availability.delete', 'availability', 'Delete availability profiles'),

-- Communications
('communications.domain.read', 'communications', 'View domains'),
('communications.domain.create', 'communications', 'Add domains'),
('communications.domain.delete', 'communications', 'Remove domains'),
('communications.sender.read', 'communications', 'View senders'),
('communications.sender.create', 'communications', 'Create senders'),
('communications.sender.update', 'communications', 'Edit senders'),
('communications.sender.delete', 'communications', 'Delete senders'),

-- Website
('website.read', 'website', 'View website builder'),
('website.update', 'website', 'Edit website'),
('website.publish', 'website', 'Publish website')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- Phase 2: Assign permissions to system roles
-- ============================================================================

-- Owner & Admin get ALL new permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name IN ('Owner', 'Admin') AND r.is_system = TRUE
AND p.category IN ('event', 'crm', 'availability', 'communications', 'website')
ON CONFLICT DO NOTHING;

-- Manager gets read + create + update (no delete, no send campaigns)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Manager' AND r.is_system = TRUE
AND p.key IN (
  'event.read', 'event.create', 'event.update', 'event.attendee.read',
  'crm.contact.read', 'crm.contact.create', 'crm.contact.update',
  'crm.segment.read', 'crm.segment.create', 'crm.segment.update',
  'crm.campaign.read', 'crm.campaign.create', 'crm.campaign.update',
  'availability.read', 'availability.create', 'availability.update',
  'communications.sender.read',
  'website.read', 'website.update'
)
ON CONFLICT DO NOTHING;

-- Staff gets read-only + limited actions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Staff' AND r.is_system = TRUE
AND p.key IN (
  'event.read', 'event.attendee.read', 'event.attendee.checkin',
  'crm.contact.read', 'crm.segment.read', 'crm.campaign.read',
  'availability.read',
  'website.read'
)
ON CONFLICT DO NOTHING;

-- Viewer gets read-only for new categories
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Viewer' AND r.is_system = TRUE
AND p.key LIKE '%.read'
AND p.category IN ('event', 'crm', 'availability', 'communications', 'website')
ON CONFLICT DO NOTHING;
