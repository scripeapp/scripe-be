-- 0001_baseline_schemas_roles.down.sql
-- Reverts schema-owned objects only. Cluster login roles belong to bootstrap.
-- Runs as surge_migrator, never as a runtime role.

alter default privileges for role surge_migrator in schema auth
  revoke select, insert, update, delete on tables from surge_app;
alter default privileges for role surge_migrator in schema app
  revoke select, insert, update, delete on tables from surge_app;
alter default privileges for role surge_migrator in schema auth, app
  revoke usage, select on sequences from surge_app;
alter default privileges for role surge_migrator in schema auth, app
  revoke execute on functions from surge_app;

drop schema if exists app cascade;
drop schema if exists auth cascade;
