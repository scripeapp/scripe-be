-- 0003_app_rls_foundation.down.sql
-- Reverts 0003: drops the app.current_*() helper functions.
-- Runs as scripe_migrator.

drop function if exists app.current_business_id();
drop function if exists app.current_user_id();
