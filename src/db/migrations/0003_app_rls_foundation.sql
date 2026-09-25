-- 0003_app_rls_foundation.sql
-- RLS infrastructure for the `app` schema (defense-in-depth, rule D).
-- Policies read identity from transaction-local config set by the app:
--   app.user_id, app.business_id, app.request_id
-- Runtime roles never hold BYPASSRLS; migrations belong to scripe_migrator.
-- Auth-schema tables stay under Better Auth and are NOT RLS-enforced here.

-- A convenience parameter accessor; safe for use inside policies.
create or replace function app.current_user_id() returns text
language sql stable
as $$
  select nullif(current_setting('app.user_id', true), '');
$$;

create or replace function app.current_business_id() returns text
language sql stable
as $$
  select nullif(current_setting('app.business_id', true), '');
$$;

-- Grant policy evaluation reads to the runtime roles.
grant execute on function app.current_user_id() to scripe_app, scripe_worker;
grant execute on function app.current_business_id() to scripe_app, scripe_worker;

revoke all on function app.current_user_id() from public;
revoke all on function app.current_business_id() from public;
