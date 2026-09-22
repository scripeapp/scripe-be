-- 0006_app_user_addresses.down.sql
-- Reverts 0006. Runs as the surge_migrator.

drop trigger if exists user_addresses_set_updated_at on app.user_addresses;
drop table if exists app.user_addresses;
drop function if exists app.set_updated_at();
