-- CRM Feature: Contacts, Segments, and Campaigns
-- Migration: 20251228_create_crm_tables.sql

-- ============================================================================
-- Contacts table
-- ============================================================================
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  status VARCHAR(20) NOT NULL DEFAULT 'marketing' CHECK (status IN ('marketing', 'transactional', 'unsubscribed', 'blocked')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, email)
);

-- ============================================================================
-- Segments table (with dynamic segment support)
-- ============================================================================
CREATE TABLE IF NOT EXISTS segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  type VARCHAR(20) DEFAULT 'static' CHECK (type IN ('dynamic', 'static')),
  track_membership_changes BOOLEAN DEFAULT FALSE,
  logic VARCHAR(5) DEFAULT 'AND' CHECK (logic IN ('AND', 'OR')),
  groups JSONB DEFAULT '[]',
  filters JSONB DEFAULT '{}',
  contact_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- Junction table for contacts <-> segments (many-to-many)
-- ============================================================================
CREATE TABLE IF NOT EXISTS contact_segments (
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  segment_id UUID NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, segment_id)
);

-- ============================================================================
-- Campaigns table (enhanced with audience targeting and metrics)
-- ============================================================================
CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  type VARCHAR(20) DEFAULT 'broadcast' CHECK (type IN ('broadcast', 'automated')),
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'paused', 'failed', 'cancelled')),
  audience_type VARCHAR(20) NOT NULL DEFAULT 'all_contacts' CHECK (audience_type IN ('all_contacts', 'segment', 'manual')),
  audience_ref JSONB DEFAULT NULL,
  audience_count INTEGER DEFAULT 0,
  excluded_count INTEGER DEFAULT 0,
  subject VARCHAR(255) NOT NULL,
  from_name VARCHAR(100) NOT NULL DEFAULT 'Hilaq',
  from_email VARCHAR(255) DEFAULT 'noreply@hilaq.com',
  content JSONB DEFAULT '{"html":"","text":""}',
  send_type VARCHAR(20) DEFAULT 'immediate' CHECK (send_type IN ('immediate', 'scheduled')),
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  metrics JSONB DEFAULT '{"sent":0,"delivered":0,"opens":0,"clicks":0,"bounces":0,"unsubscribes":0}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- Indexes for efficient querying
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(user_id, email);

CREATE INDEX IF NOT EXISTS idx_segments_user_id ON segments(user_id);

CREATE INDEX IF NOT EXISTS idx_contact_segments_contact ON contact_segments(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_segments_segment ON contact_segments(segment_id);

CREATE INDEX IF NOT EXISTS idx_campaigns_user_id ON campaigns(user_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

-- ============================================================================
-- Segment Activity table (for tracking segment events)
-- ============================================================================
CREATE TABLE IF NOT EXISTS segment_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id UUID NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  event_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_segment_activity_segment ON segment_activity(segment_id);
CREATE INDEX IF NOT EXISTS idx_segment_activity_created ON segment_activity(segment_id, created_at DESC);
