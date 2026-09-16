-- Drop all Telegram bot tables (reverses 20260705_telegram_bot_tables.sql)
DROP TABLE IF EXISTS telegram_link_codes;
DROP TABLE IF EXISTS telegram_payment_intents;
DROP TABLE IF EXISTS telegram_processed_updates;
DROP TABLE IF EXISTS telegram_sessions;
DROP TABLE IF EXISTS telegram_users;
