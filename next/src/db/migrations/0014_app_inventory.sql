insert into app.permissions ("code", "description") values
  ('inventory.read', 'View inventory and stock balances'),
  ('inventory.manage', 'Post inventory movements and manage stock custody'),
  ('inventory.reserve', 'Reserve and release stock')
on conflict ("code") do nothing;
insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
on conflict do nothing;

create table app.inventory_items (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "variantId" uuid,
  "name" text not null check (length(trim("name")) between 1 and 200),
  "sku" text,
  "trackingMode" text not null default 'quantity' check ("trackingMode" in ('quantity', 'lot', 'serial')),
  "status" text not null default 'active' check ("status" in ('active', 'archived')),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("id", "businessId"),
  unique ("businessId", "sku"),
  foreign key ("variantId", "businessId") references app.product_variants ("id", "businessId") on delete restrict
);
create index inventory_items_business_idx on app.inventory_items ("businessId", "status", "name");

create table app.inventory_locations (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "locationId" uuid not null,
  "name" text not null check (length(trim("name")) between 1 and 120),
  "status" text not null default 'active' check ("status" in ('active', 'archived')),
  "createdAt" timestamptz not null default now(),
  unique ("id", "businessId"),
  unique ("businessId", "locationId", "name"),
  foreign key ("locationId", "businessId") references app.locations ("id", "businessId") on delete restrict
);

create table app.stock_transactions (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "type" text not null check ("type" in ('receipt', 'sale', 'return', 'adjustment', 'transfer_in', 'transfer_out', 'waste', 'count', 'reservation', 'release')),
  "reason" text not null check (length(trim("reason")) between 1 and 500),
  "actorUserId" uuid not null references auth.user ("id") on delete restrict,
  "requestId" text not null,
  "idempotencyKey" text not null,
  "createdAt" timestamptz not null default now(),
  unique ("businessId", "idempotencyKey")
);

create table app.stock_balances (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "inventoryItemId" uuid not null,
  "inventoryLocationId" uuid not null,
  "onHand" numeric(20,6) not null default 0 check ("onHand" >= 0),
  "reserved" numeric(20,6) not null default 0 check ("reserved" >= 0 and "reserved" <= "onHand"),
  "updatedAt" timestamptz not null default now(),
  unique ("businessId", "inventoryItemId", "inventoryLocationId"),
  foreign key ("inventoryItemId", "businessId") references app.inventory_items ("id", "businessId") on delete restrict,
  foreign key ("inventoryLocationId", "businessId") references app.inventory_locations ("id", "businessId") on delete restrict
);

create table app.stock_movements (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "transactionId" uuid not null,
  "inventoryItemId" uuid not null,
  "inventoryLocationId" uuid not null,
  "quantity" numeric(20,6) not null check ("quantity" <> 0),
  "unitCostMinor" bigint check ("unitCostMinor" is null or "unitCostMinor" >= 0),
  "createdAt" timestamptz not null default now(),
  foreign key ("transactionId") references app.stock_transactions ("id") on delete restrict,
  foreign key ("inventoryItemId", "businessId") references app.inventory_items ("id", "businessId") on delete restrict,
  foreign key ("inventoryLocationId", "businessId") references app.inventory_locations ("id", "businessId") on delete restrict
);
create index stock_movements_lookup_idx on app.stock_movements ("businessId", "inventoryItemId", "inventoryLocationId", "createdAt" desc);

create table app.stock_reservations (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "inventoryItemId" uuid not null,
  "inventoryLocationId" uuid not null,
  "quantity" numeric(20,6) not null check ("quantity" > 0),
  "referenceType" text not null check (length(trim("referenceType")) between 1 and 40),
  "referenceId" text not null check (length(trim("referenceId")) between 1 and 160),
  "status" text not null default 'active' check ("status" in ('active', 'released', 'expired')),
  "expiresAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  "releasedAt" timestamptz,
  unique ("businessId", "referenceType", "referenceId", "inventoryItemId", "inventoryLocationId"),
  foreign key ("inventoryItemId", "businessId") references app.inventory_items ("id", "businessId") on delete restrict,
  foreign key ("inventoryLocationId", "businessId") references app.inventory_locations ("id", "businessId") on delete restrict
);

create trigger inventory_items_set_updated_at before update on app.inventory_items for each row execute function app.set_updated_at();
create trigger stock_balances_set_updated_at before update on app.stock_balances for each row execute function app.set_updated_at();
create or replace function app.reject_stock_immutable_change() returns trigger language plpgsql as $$ begin raise exception 'immutable stock record' using errcode = '23000'; end $$;
create trigger stock_transactions_immutable before update or delete on app.stock_transactions for each row execute function app.reject_stock_immutable_change();
create trigger stock_movements_immutable before update or delete on app.stock_movements for each row execute function app.reject_stock_immutable_change();

alter table app.inventory_items enable row level security;
alter table app.inventory_locations enable row level security;
alter table app.stock_transactions enable row level security;
alter table app.stock_balances enable row level security;
alter table app.stock_movements enable row level security;
alter table app.stock_reservations enable row level security;
create policy inventory_items_read on app.inventory_items for select using (app.has_business_permission("businessId", 'inventory.read'));
create policy inventory_items_write on app.inventory_items for all using (app.has_business_permission("businessId", 'inventory.manage')) with check (app.has_business_permission("businessId", 'inventory.manage'));
create policy inventory_locations_read on app.inventory_locations for select using (app.has_business_permission("businessId", 'inventory.read'));
create policy inventory_locations_write on app.inventory_locations for all using (app.has_business_permission("businessId", 'inventory.manage')) with check (app.has_business_permission("businessId", 'inventory.manage'));
create policy stock_transactions_read on app.stock_transactions for select using (app.has_business_permission("businessId", 'inventory.read'));
create policy stock_transactions_insert on app.stock_transactions for insert with check (app.has_business_permission("businessId", 'inventory.manage'));
create policy stock_balances_read on app.stock_balances for select using (app.has_business_permission("businessId", 'inventory.read'));
create policy stock_balances_write on app.stock_balances for all using (app.has_business_permission("businessId", 'inventory.manage')) with check (app.has_business_permission("businessId", 'inventory.manage'));
create policy stock_movements_read on app.stock_movements for select using (app.has_business_permission("businessId", 'inventory.read'));
create policy stock_movements_insert on app.stock_movements for insert with check (app.has_business_permission("businessId", 'inventory.manage'));
create policy stock_reservations_read on app.stock_reservations for select using (app.has_business_permission("businessId", 'inventory.read'));
create policy stock_reservations_write on app.stock_reservations for all using (app.has_business_permission("businessId", 'inventory.reserve')) with check (app.has_business_permission("businessId", 'inventory.reserve'));
grant select, insert, update on app.inventory_items, app.inventory_locations, app.stock_transactions, app.stock_balances, app.stock_movements, app.stock_reservations to surge_app;
