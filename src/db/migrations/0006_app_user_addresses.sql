-- 0006_app_user_addresses.sql
-- Wave-A slice 1 (rules.md §F.3 baseline schemas): saved delivery addresses.
-- Mirrors the legacy user_addresses product columns (rules.md §C evidence-only,
-- no invented columns) translated to the new conventions: app schema, quoted
-- camelCase, auth.user FK via the shared app.current_user_id() RLS helper,
-- grants to scripe_app only (scripe_worker/scripe_readonly get nothing here).
-- Runs as the scripe_migrator.

-- Shared updated-at helper, shipped once here (rules.md §D: reuse, don't
-- reinvent); 0007 references it rather than redefining it.
create or replace function app.set_updated_at()
returns trigger
language plpgsql
set search_path = app, pg_temp
as $$
begin
  new."updatedAt" = now();
  return new;
end $$;

create table app.user_addresses (
  "id"            uuid        primary key default gen_random_uuid(),
  "userId"        uuid        not null references auth.user ("id") on delete cascade,
  "label"         text,
  "isDefault"     boolean     not null default false,
  "recipientName" text        not null,
  "phone"         text        not null,
  "addressLine1"  text        not null,
  "addressLine2"  text,
  "city"          text        not null,
  "state"         text        not null,
  "postalCode"    text,
  "country"       text        not null default 'Nigeria',
  "createdAt"     timestamptz not null default now(),
  "updatedAt"     timestamptz   not null default now()
);

-- Exactly one default per user, enforced declaratively (DRI) instead of the
-- legacy single-default trigger (rules.md §G declarative-over-trigger).
create unique index user_addresses_one_default_per_user
  on app.user_addresses ("userId")
  where "isDefault";

comment on table app.user_addresses is
  'Saved delivery/contact addresses owned by a user (1:1 user ownership).';

create trigger user_addresses_set_updated_at
  before update on app.user_addresses
  for each row execute function app.set_updated_at();

-- RLS: users manage only their own addresses (app.current_user_id() helper).
alter table app.user_addresses enable row level security;

create policy user_addresses_select_own on app.user_addresses
  for select
  using (app.current_user_id() = "userId"::text);

create policy user_addresses_insert_own on app.user_addresses
  for insert
  with check (app.current_user_id() = "userId"::text);

create policy user_addresses_update_own on app.user_addresses
  for update
  using (app.current_user_id() = "userId"::text)
  with check (app.current_user_id() = "userId"::text);

create policy user_addresses_delete_own on app.user_addresses
  for delete
  using (app.current_user_id() = "userId"::text);

grant select, insert, update, delete on app.user_addresses to scripe_app;
grant execute on function app.set_updated_at() to scripe_app;
