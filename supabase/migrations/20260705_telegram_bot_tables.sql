-- ============================================================================
-- Telegram Bot — M1 tables
-- ============================================================================
-- Central Hilaq Telegram bot (see docs/telegram-bot-architecture.md).
-- All access goes through the backend with the service-role client; there is
-- no browser/user access, so RLS is enabled with no public policies.
--
-- telegram_users            one row per Telegram user who has talked to the bot;
--                           remembers guest checkout details and (later) the
--                           link to a Hilaq account.
-- telegram_sessions         one row per chat; stores the in-progress action
--                           state machine so flows survive serverless restarts.
-- telegram_processed_updates dedupe log — Telegram retries undelivered webhook
--                           updates, so each update_id is processed once.
-- telegram_payment_intents  maps a payment reference to the chat that started
--                           it, so the Paystack webhook can push the receipt
--                           back into the right Telegram conversation.
-- telegram_link_codes       one-time email verification codes for linking a
--                           Telegram user to an existing Hilaq account.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS telegram_users (
  telegram_user_id bigint PRIMARY KEY,
  chat_id bigint NOT NULL,
  username varchar(64),
  first_name varchar(128),
  hilaq_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  guest_name varchar(160),
  guest_email varchar(255),
  created_at timestamptz DEFAULT now(),
  last_seen_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_users_hilaq_user_id
  ON telegram_users(hilaq_user_id);

CREATE TABLE IF NOT EXISTS telegram_sessions (
  chat_id bigint PRIMARY KEY,
  telegram_user_id bigint REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE,
  active_action varchar(64),
  step varchar(64),
  collected_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telegram_processed_updates (
  update_id bigint PRIMARY KEY,
  received_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telegram_payment_intents (
  reference varchar(100) PRIMARY KEY,
  chat_id bigint NOT NULL,
  telegram_user_id bigint REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE,
  kind varchar(32) NOT NULL CHECK (kind IN ('event_ticket', 'store_order')),
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'expired')),
  created_at timestamptz DEFAULT now(),
  paid_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_telegram_payment_intents_chat_id
  ON telegram_payment_intents(chat_id);

CREATE TABLE IF NOT EXISTS telegram_link_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id bigint NOT NULL,
  telegram_user_id bigint NOT NULL,
  hilaq_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email varchar(255) NOT NULL,
  code varchar(12) NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_link_codes_chat_id
  ON telegram_link_codes(chat_id);

ALTER TABLE telegram_link_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_processed_updates ENABLE ROW LEVEL SECURITY;

COMMIT;
