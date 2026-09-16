-- Fix Campaigns Table: Add All Missing Columns
-- 20260107_fix_campaigns_columns.sql

-- Core fields
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS name VARCHAR(255);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'broadcast';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'draft';

-- Audience fields
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_type VARCHAR(50) DEFAULT 'all_contacts';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_ref JSONB;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_count INTEGER DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS excluded_count INTEGER DEFAULT 0;

-- Email content fields
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS subject VARCHAR(255);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS from_name VARCHAR(100) DEFAULT 'Hilaq';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS from_email VARCHAR(255) DEFAULT 'noreply@hilaq.com';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS content JSONB DEFAULT '{"html": "", "text": ""}'::jsonb;

-- Scheduling fields
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS send_type VARCHAR(50) DEFAULT 'immediate';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

-- Metrics
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS metrics JSONB DEFAULT '{"sent": 0, "delivered": 0, "opens": 0, "clicks": 0, "bounces": 0, "unsubscribes": 0}'::jsonb;

-- Timestamps
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
