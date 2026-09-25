-- 0004_app_user_profiles.down.sql
-- Reverts 0004. Runs as scripe_migrator.

drop trigger if exists auth_user_profile_sync on auth.user;
drop function if exists app.sync_user_profile();
drop table if exists app.user_profiles;