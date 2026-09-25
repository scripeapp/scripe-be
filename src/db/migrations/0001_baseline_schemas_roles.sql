-- 0001_baseline_schemas_roles.sql
-- Runs as scripe_migrator. Defines schemas and runtime roles.
-- auth  = Better Auth owns its tables/columns; migrator creates the schema shell.
-- app   = product/domain tables.

create schema if not exists auth;
create schema if not exists app;

alter schema auth owner to scripe_migrator;
alter schema app owner to scripe_migrator;

grant usage on schema auth to scripe_app;
grant usage on schema app to scripe_app, scripe_worker;
grant usage on schema app to scripe_readonly;

-- Runtime API defaults are intentionally limited to scripe_app. Worker and
-- reporting access must be granted explicitly by the migration that needs it.
alter default privileges for role scripe_migrator in schema auth
  grant select, insert, update, delete on tables to scripe_app;
alter default privileges for role scripe_migrator in schema app
  grant select, insert, update, delete on tables to scripe_app;
alter default privileges for role scripe_migrator in schema auth, app
  grant usage, select on sequences to scripe_app;
alter default privileges for role scripe_migrator in schema auth, app
  revoke execute on functions from public;
alter default privileges for role scripe_migrator in schema auth, app
  grant execute on functions to scripe_app;
