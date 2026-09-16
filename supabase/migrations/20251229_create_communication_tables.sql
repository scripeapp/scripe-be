-- Communication Domains & Senders
-- Migration: 20251229_create_communication_tables.sql

-- ============================================================================
-- Domains table - for custom domain verification
-- ============================================================================
CREATE TABLE IF NOT EXISTS communication_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  domain VARCHAR(255) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed', 'needs_attention')),
  dns_records JSONB NOT NULL DEFAULT '[]',
  verified_at TIMESTAMPTZ,
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, domain)
);

-- ============================================================================
-- Sender identities table - email addresses for sending
-- ============================================================================
CREATE TABLE IF NOT EXISTS communication_senders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  domain_id UUID REFERENCES communication_domains(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL,
  is_default BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  used_by JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- Indexes for performance
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_communication_domains_user ON communication_domains(user_id);
CREATE INDEX IF NOT EXISTS idx_communication_domains_status ON communication_domains(status);
CREATE INDEX IF NOT EXISTS idx_communication_senders_user ON communication_senders(user_id);
CREATE INDEX IF NOT EXISTS idx_communication_senders_domain ON communication_senders(domain_id);
CREATE INDEX IF NOT EXISTS idx_communication_senders_default ON communication_senders(user_id, is_default) WHERE is_default = true;
