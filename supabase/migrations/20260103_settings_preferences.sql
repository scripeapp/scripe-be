-- Migration: Settings Preferences
-- Created: 2026-01-03
-- Adds notification_preferences and preferences columns to users,
-- and monetization column to publications

-- ============================================================================
-- 1. Notification Preferences on Users
-- ============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_preferences JSONB DEFAULT '{
  "email_new_subscriber": true,
  "email_new_order": true,
  "email_order_update": true,
  "email_new_comment": true,
  "email_marketing": false,
  "email_product_updates": true
}'::jsonb;

-- ============================================================================
-- 2. User Preferences (timezone, currency, locale, theme)
-- Note: last_active_store_id and last_active_publication_id are in user_preferences table
-- ============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{
  "timezone": "Africa/Lagos",
  "currency": "NGN",
  "locale": "en",
  "theme": "light"
}'::jsonb;

-- ============================================================================
-- 3. Publication Monetization Settings
-- ============================================================================
ALTER TABLE publications ADD COLUMN IF NOT EXISTS monetization JSONB DEFAULT '{
  "enabled": false,
  "subscription_price": null,
  "currency": "NGN",
  "allow_free_tier": true
}'::jsonb;

-- ============================================================================
-- 4. Wallet Payout Preferences (on users or a separate wallet table)
-- Adding to users for simplicity
-- ============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_preferences JSONB DEFAULT '{
  "payout_frequency": "automatic",
  "minimum_payout": 1000,
  "hold_payouts": false
}'::jsonb;
