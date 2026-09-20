-- Stores vertical slice: stores, locations, sales channels, registers, POS
-- devices, register shifts, and immutable cash movements.

create table app.stores (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "name" text not null check (length(trim("name")) between 1 and 160),
  "slug" text not null unique check ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  "description" text not null default '',
  "status" text not null default 'draft' check ("status" in ('draft', 'active', 'archived')),
  "isDefault" boolean not null default false,
  "sellsOnline" boolean not null default true,
  "sellsInPerson" boolean not null default false,
  "contactEmail" text,
  "contactPhone" text,
  "timezone" text not null default 'Africa/Lagos',
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "archivedAt" timestamptz,
  unique ("id", "businessId")
);

create unique index stores_one_active_default_per_business
  on app.stores ("businessId") where "isDefault" and "status" <> 'archived';
create index stores_business_status_idx on app.stores ("businessId", "status", "createdAt" desc);

create table app.locations (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "storeId" uuid not null,
  "name" text not null check (length(trim("name")) between 1 and 160),
  "kind" text not null default 'branch' check ("kind" in ('branch', 'warehouse', 'kitchen', 'pharmacy', 'stockroom')),
  "status" text not null default 'active' check ("status" in ('active', 'inactive', 'archived')),
  "isDefault" boolean not null default false,
  "addressLine1" text,
  "addressLine2" text,
  "city" text,
  "state" text,
  "postalCode" text,
  "countryCode" text not null default 'NG' check ("countryCode" ~ '^[A-Z]{2}$'),
  "latitude" numeric(9,6),
  "longitude" numeric(9,6),
  "phone" text,
  "timezone" text not null default 'Africa/Lagos',
  "businessHours" jsonb not null default '{}'::jsonb check (jsonb_typeof("businessHours") = 'object'),
  "prepTimeMinutes" integer check ("prepTimeMinutes" is null or "prepTimeMinutes" between 0 and 1440),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "archivedAt" timestamptz,
  foreign key ("storeId", "businessId") references app.stores ("id", "businessId") on delete restrict,
  unique ("id", "businessId"),
  unique ("id", "storeId", "businessId"),
  check ("latitude" is null or "latitude" between -90 and 90),
  check ("longitude" is null or "longitude" between -180 and 180)
);

create unique index locations_one_active_default_per_store
  on app.locations ("storeId") where "isDefault" and "status" <> 'archived';
create index locations_business_store_idx on app.locations ("businessId", "storeId", "status", "createdAt" desc);

create table app.sales_channels (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "storeId" uuid not null,
  "code" text not null check ("code" ~ '^[a-z][a-z0-9_]{1,39}$'),
  "name" text not null check (length(trim("name")) between 1 and 100),
  "kind" text not null check ("kind" in ('storefront', 'pos', 'manual_invoice', 'qr', 'other')),
  "status" text not null default 'active' check ("status" in ('active', 'paused', 'archived')),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  foreign key ("storeId", "businessId") references app.stores ("id", "businessId") on delete restrict,
  unique ("storeId", "code"),
  unique ("id", "storeId", "businessId")
);

create index sales_channels_business_store_idx on app.sales_channels ("businessId", "storeId", "status");

create table app.registers (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "storeId" uuid not null,
  "locationId" uuid not null,
  "name" text not null check (length(trim("name")) between 1 and 100),
  "status" text not null default 'active' check ("status" in ('active', 'inactive', 'archived')),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "archivedAt" timestamptz,
  foreign key ("storeId", "businessId") references app.stores ("id", "businessId") on delete restrict,
  foreign key ("locationId", "storeId", "businessId") references app.locations ("id", "storeId", "businessId") on delete restrict,
  unique ("id", "businessId"),
  unique ("id", "storeId", "businessId"),
  unique ("storeId", "name")
);

create index registers_business_store_idx on app.registers ("businessId", "storeId", "status");
create index registers_location_idx on app.registers ("businessId", "locationId", "status");

create table app.pos_devices (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "storeId" uuid not null,
  "registerId" uuid not null,
  "label" text not null check (length(trim("label")) between 1 and 100),
  "platform" text not null default 'web' check ("platform" in ('web', 'android', 'ios', 'pos_terminal')),
  "status" text not null default 'pending' check ("status" in ('pending', 'active', 'revoked')),
  "pairingCodeHash" text,
  "pairingCodeExpiresAt" timestamptz,
  "tokenHash" text unique,
  "pairedAt" timestamptz,
  "lastSeenAt" timestamptz,
  "revokedAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  foreign key ("registerId", "storeId", "businessId") references app.registers ("id", "storeId", "businessId") on delete restrict,
  unique ("id", "businessId"),
  check (("status" = 'active') = ("tokenHash" is not null))
);

create unique index pos_devices_pairing_code_unique on app.pos_devices ("pairingCodeHash") where "pairingCodeHash" is not null;
create index pos_devices_register_idx on app.pos_devices ("businessId", "registerId", "status");

create table app.register_shifts (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "storeId" uuid not null,
  "locationId" uuid not null,
  "registerId" uuid not null,
  "openedByMembershipId" uuid not null,
  "closedByMembershipId" uuid,
  "openingCashMinor" bigint not null default 0 check ("openingCashMinor" >= 0),
  "expectedCashMinor" bigint,
  "countedCashMinor" bigint,
  "varianceMinor" bigint,
  "status" text not null default 'open' check ("status" in ('open', 'closed')),
  "openedAt" timestamptz not null default now(),
  "closedAt" timestamptz,
  "notes" text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  foreign key ("registerId", "storeId", "businessId") references app.registers ("id", "storeId", "businessId") on delete restrict,
  foreign key ("locationId", "storeId", "businessId") references app.locations ("id", "storeId", "businessId") on delete restrict,
  foreign key ("openedByMembershipId", "businessId") references app.business_memberships ("id", "businessId") on delete restrict,
  foreign key ("closedByMembershipId", "businessId") references app.business_memberships ("id", "businessId") on delete restrict,
  unique ("id", "businessId"),
  check (("status" = 'open' and "closedAt" is null and "countedCashMinor" is null)
      or ("status" = 'closed' and "closedAt" is not null and "countedCashMinor" is not null and "expectedCashMinor" is not null and "varianceMinor" is not null))
);

create unique index register_shifts_one_open_per_register on app.register_shifts ("registerId") where "status" = 'open';
create index register_shifts_business_register_idx on app.register_shifts ("businessId", "registerId", "openedAt" desc);

create table app.cash_movements (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "storeId" uuid not null,
  "locationId" uuid not null,
  "registerId" uuid not null,
  "shiftId" uuid not null,
  "type" text not null check ("type" in ('cash_in', 'cash_out', 'safe_drop', 'adjustment')),
  "amountMinor" bigint not null check ("amountMinor" > 0),
  "reason" text not null check (length(trim("reason")) between 1 and 500),
  "actorMembershipId" uuid not null,
  "requestId" text not null,
  "idempotencyKey" text not null,
  "occurredAt" timestamptz not null default now(),
  "createdAt" timestamptz not null default now(),
  foreign key ("shiftId", "businessId") references app.register_shifts ("id", "businessId") on delete restrict,
  foreign key ("registerId", "storeId", "businessId") references app.registers ("id", "storeId", "businessId") on delete restrict,
  foreign key ("locationId", "storeId", "businessId") references app.locations ("id", "storeId", "businessId") on delete restrict,
  foreign key ("actorMembershipId", "businessId") references app.business_memberships ("id", "businessId") on delete restrict,
  unique ("businessId", "idempotencyKey")
);

create index cash_movements_shift_idx on app.cash_movements ("businessId", "shiftId", "occurredAt" desc);

create trigger stores_set_updated_at before update on app.stores for each row execute function app.set_updated_at();
create trigger locations_set_updated_at before update on app.locations for each row execute function app.set_updated_at();
create trigger sales_channels_set_updated_at before update on app.sales_channels for each row execute function app.set_updated_at();
create trigger registers_set_updated_at before update on app.registers for each row execute function app.set_updated_at();
create trigger pos_devices_set_updated_at before update on app.pos_devices for each row execute function app.set_updated_at();
create trigger register_shifts_set_updated_at before update on app.register_shifts for each row execute function app.set_updated_at();

create or replace function app.reject_immutable_change() returns trigger language plpgsql as $$
begin raise exception 'immutable record' using errcode = '23000'; end $$;
create trigger cash_movements_immutable before update or delete on app.cash_movements
  for each row execute function app.reject_immutable_change();

alter table app.stores enable row level security;
alter table app.locations enable row level security;
alter table app.sales_channels enable row level security;
alter table app.registers enable row level security;
alter table app.pos_devices enable row level security;
alter table app.register_shifts enable row level security;
alter table app.cash_movements enable row level security;

create policy stores_read on app.stores for select using (app.has_business_permission("businessId", 'store.read'));
create policy stores_create on app.stores for insert with check (app.has_business_permission("businessId", 'store.create'));
create policy stores_update on app.stores for update using (app.has_business_permission("businessId", 'store.update')) with check (app.has_business_permission("businessId", 'store.update'));

create policy locations_read on app.locations for select using (app.has_business_permission("businessId", 'store.read'));
create policy locations_write on app.locations for all using (app.has_business_permission("businessId", 'location.manage')) with check (app.has_business_permission("businessId", 'location.manage'));
create policy channels_read on app.sales_channels for select using (app.has_business_permission("businessId", 'store.read'));
create policy channels_write on app.sales_channels for all using (app.has_business_permission("businessId", 'channel.manage')) with check (app.has_business_permission("businessId", 'channel.manage'));
create policy registers_read on app.registers for select using (app.has_business_permission("businessId", 'store.read'));
create policy registers_write on app.registers for all using (app.has_business_permission("businessId", 'register.manage')) with check (app.has_business_permission("businessId", 'register.manage'));
create policy devices_read on app.pos_devices for select using (app.has_business_permission("businessId", 'store.read'));
create policy devices_write on app.pos_devices for all using (app.has_business_permission("businessId", 'register.manage')) with check (app.has_business_permission("businessId", 'register.manage'));
create policy shifts_read on app.register_shifts for select using (app.has_business_permission("businessId", 'store.read'));
create policy shifts_insert on app.register_shifts for insert with check (app.has_business_permission("businessId", 'register.operate'));
create policy shifts_update on app.register_shifts for update using (app.has_business_permission("businessId", 'register.operate')) with check (app.has_business_permission("businessId", 'register.operate'));
create policy cash_read on app.cash_movements for select using (app.has_business_permission("businessId", 'store.read'));
create policy cash_insert on app.cash_movements for insert with check (app.has_business_permission("businessId", 'cash.manage'));

grant select, insert, update on app.stores, app.locations, app.sales_channels, app.registers, app.pos_devices, app.register_shifts to surge_app;
grant select, insert on app.cash_movements to surge_app;

comment on table app.cash_movements is 'Immutable register cash events; corrections are compensating movements.';

create or replace function app.create_business_with_default_store(
  business_display_name text,
  business_currency text,
  business_timezone text,
  business_vertical text,
  default_store_slug text
)
returns table (
  "id" uuid,
  "displayName" text,
  "status" text,
  "defaultCurrency" text,
  "timezone" text,
  "primaryVertical" text,
  "createdBy" uuid,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "archivedAt" timestamptz
)
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  actor_id uuid;
  new_business_id uuid := gen_random_uuid();
  new_membership_id uuid := gen_random_uuid();
  owner_role_id uuid;
begin
  actor_id := nullif(app.current_user_id(), '')::uuid;
  if actor_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select role."id" into owner_role_id
  from app.roles role
  where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  limit 1;
  if owner_role_id is null then
    raise exception 'owner role is not configured' using errcode = '55000';
  end if;

  insert into app.businesses ("id", "displayName", "defaultCurrency", "timezone", "primaryVertical", "createdBy")
  values (new_business_id, business_display_name, business_currency, business_timezone, business_vertical, actor_id);

  insert into app.business_memberships ("id", "businessId", "userId", "status")
  values (new_membership_id, new_business_id, actor_id, 'active');

  insert into app.membership_roles ("membershipId", "businessId", "roleId")
  values (new_membership_id, new_business_id, owner_role_id);

  insert into app.stores ("businessId", "name", "slug", "status", "isDefault", "createdBy", "timezone")
  values (new_business_id, business_display_name, default_store_slug, 'draft', true, actor_id, business_timezone);

  return query
  select business."id", business."displayName", business."status", business."defaultCurrency",
    business."timezone", business."primaryVertical", business."createdBy", business."createdAt",
    business."updatedAt", business."archivedAt"
  from app.businesses business where business."id" = new_business_id;
end;
$$;

revoke all on function app.create_business_with_default_store(text, text, text, text, text) from public;
grant execute on function app.create_business_with_default_store(text, text, text, text, text) to surge_app;
