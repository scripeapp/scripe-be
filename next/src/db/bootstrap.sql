-- bootstrap.sql
-- Run as a superuser (e.g. `postgres`) against a fresh database cluster,
-- BEFORE any migrations. Creates the migration/runtime roles the schema
-- migrations expect. Idempotent: safe to re-run.
--
-- Usage:
--   psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f bootstrap.sql
--   psql -U postgres -d surge_dev -v ON_ERROR_STOP=1 -f bootstrap.sql

\set ON_ERROR_STOP on

do $$
begin
  -- Cluster roles are bootstrap-owned. Schema migrations must never create or
  -- drop login roles, which would make rollback destructive at cluster scope.
  if not exists (select 1 from pg_roles where rolname = 'surge_migrator') then
    create role surge_migrator login;
  end if;

  -- Runtime roles: connect as the app against the DB; never superuser.
  if not exists (select 1 from pg_roles where rolname = 'surge_app') then
    create role surge_app login;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'surge_worker') then
    create role surge_worker login;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'surge_readonly') then
    create role surge_readonly login;
  end if;
end
$$;

alter role surge_migrator nosuperuser nocreatedb nocreaterole nobypassrls;
alter role surge_app nosuperuser nocreatedb nocreaterole nobypassrls;
alter role surge_worker nosuperuser nocreatedb nocreaterole nobypassrls;
alter role surge_readonly nosuperuser nocreatedb nocreaterole nobypassrls;

-- The migrator may create this application's schemas and Kysely metadata in
-- the current database, but it has no cluster-wide role/database powers.
grant usage, create on schema public to surge_migrator;
do $$
begin
  execute format(
    'grant connect, create on database %I to surge_migrator',
    current_database()
  );
  execute format(
    'grant connect on database %I to surge_app, surge_worker, surge_readonly',
    current_database()
  );
end
$$;
