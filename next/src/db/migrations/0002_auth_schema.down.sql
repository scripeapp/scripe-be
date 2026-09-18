-- 0002_auth_schema.down.sql
-- Reverts 0002: drops Better Auth tables. Order respects FK references.
-- Runs as surge_migrator.

drop table if exists auth.verification;
drop table if exists auth.passkey;
drop table if exists auth.session;
drop table if exists auth.account;
drop table if exists auth.user;
