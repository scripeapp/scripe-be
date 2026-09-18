-- 0004_app_user_profiles.sql
-- app.user_profiles: the product-side, 1:1 profile for auth.user (rules F.3).
-- auth.user.id is the canonical UUID; this table is a 1:1 FK to it.
-- RLS defense-in-depth: rows are readable/updatable only by the owning user
-- (transaction-local app.user_id). The profile is created transactionally by a
-- SECURITY DEFINER trigger on auth.user so signup and profile are atomic.
-- Runs as surge_migrator.

create table app.user_profiles (
    "userId"    uuid primary key references auth.user ("id") on delete cascade,
    "email"     text        not null,
    "name"      text        not null default '',
    "image"     text,
    "createdAt" timestamptz not null default now(),
    "updatedAt" timestamptz not null default now()
);

comment on table app.user_profiles is
  '1:1 product profile for auth.user. Created by the auth-sync trigger.';

create or replace function app.sync_user_profile()
returns trigger
language plpgsql
set search_path = app, pg_temp
security definer
as $$
begin
  insert into app.user_profiles (
    "userId", "email", "name", "image"
  )
  values (new."id", new."email", new."name", new."image")
  on conflict ("userId") do update
    set "email"     = excluded."email",
        "name"      = excluded."name",
        "image"     = excluded."image",
        "updatedAt" = now();
  return new;
end $$;

revoke all on function app.sync_user_profile() from public;
grant execute on function app.sync_user_profile() to surge_app;

-- Owner (surge_migrator) bypasses RLS; the definer trigger inherits that.
-- The trigger is the only insert path into app.user_profiles.
create trigger auth_user_profile_sync
after insert or update on auth.user
for each row execute function app.sync_user_profile();

alter table app.user_profiles enable row level security;

create policy user_profiles_select_own on app.user_profiles
  for select
  using (app.current_user_id() = "userId"::text);

create policy user_profiles_update_own on app.user_profiles
  for update
  using (app.current_user_id() = "userId"::text)
  with check (app.current_user_id() = "userId"::text);

create policy user_profiles_delete_own on app.user_profiles
  for delete
  using (app.current_user_id() = "userId"::text);

-- No insert policy: surge_app may never insert directly; only the trigger does.
