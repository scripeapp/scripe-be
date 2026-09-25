-- 0001_baseline_schemas_roles.down.sql
-- Reverts schema-owned objects only. Cluster login roles belong to bootstrap.
-- Runs as scripe_migrator, never as a runtime role.

alter default privileges for role scripe_migrator in schema auth
  revoke select, insert, update, delete on tables from scripe_app;
alter default privileges for role scripe_migrator in schema app
  revoke select, insert, update, delete on tables from scripe_app;
alter default privileges for role scripe_migrator in schema auth, app
  revoke usage, select on sequences from scripe_app;
alter default privileges for role scripe_migrator in schema auth, app
  revoke execute on functions from scripe_app;

drop schema if exists app cascade;
drop schema if exists auth cascade;
