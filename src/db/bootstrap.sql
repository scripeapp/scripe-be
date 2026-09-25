-- bootstrap.sql
-- Run as a superuser (e.g. `postgres`) against a fresh database cluster,
-- BEFORE any migrations. Creates the migration/runtime roles the schema
-- migrations expect. Idempotent: safe to re-run.
--
-- Usage:
--   psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f bootstrap.sql
--   psql -U postgres -d scripe_dev -v ON_ERROR_STOP=1 -f bootstrap.sql

\set ON_ERROR_STOP on

do $$
begin
  -- Cluster roles are bootstrap-owned. Schema migrations must never create or
  -- drop login roles, which would make rollback destructive at cluster scope.
  if not exists (select 1 from pg_roles where rolname = 'scripe_migrator') then
    create role scripe_migrator login;
  end if;

  -- Runtime roles: connect as the app against the DB; never superuser.
  if not exists (select 1 from pg_roles where rolname = 'scripe_app') then
    create role scripe_app login;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'scripe_worker') then
    create role scripe_worker login;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'scripe_readonly') then
    create role scripe_readonly login;
  end if;
end
$$;

alter role scripe_migrator nosuperuser nocreatedb nocreaterole nobypassrls;
alter role scripe_app nosuperuser nocreatedb nocreaterole nobypassrls;
alter role scripe_worker nosuperuser nocreatedb nocreaterole nobypassrls;
alter role scripe_readonly nosuperuser nocreatedb nocreaterole nobypassrls;

-- The migrator may create this application's schemas and Kysely metadata in
-- the current database, but it has no cluster-wide role/database powers.
grant usage, create on schema public to scripe_migrator;
do $$
begin
  execute format(
    'grant connect, create on database %I to scripe_migrator',
    current_database()
  );
  execute format(
    'grant connect on database %I to scripe_app, scripe_worker, scripe_readonly',
    current_database()
  );
end
$$;
