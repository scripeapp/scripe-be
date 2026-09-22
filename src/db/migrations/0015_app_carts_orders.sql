insert into app.permissions ("code", "description") values
  ('cart.read', 'View carts and checkout sessions'),
  ('cart.manage', 'Manage carts and checkout sessions'),
  ('order.read', 'View orders'),
  ('order.create', 'Create orders from carts')
on conflict ("code") do nothing;
insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
on conflict do nothing;

create table app.carts (
  "id" uuid primary key default gen_random_uuid(), "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "storeId" uuid not null, "channelId" uuid not null, "customerPartyId" uuid,
  "currency" text not null check ("currency" ~ '^[A-Z]{3}$'),
  "status" text not null default 'active' check ("status" in ('active','converted','abandoned')),
  "createdBy" uuid references auth.user ("id") on delete restrict, "createdAt" timestamptz not null default now(), "updatedAt" timestamptz not null default now(), "convertedAt" timestamptz,
  unique ("id", "businessId"), foreign key ("storeId", "businessId") references app.stores ("id", "businessId") on delete restrict,
  foreign key ("channelId", "storeId", "businessId") references app.sales_channels ("id", "storeId", "businessId") on delete restrict,
  foreign key ("customerPartyId", "businessId") references app.parties ("id", "businessId") on delete restrict
);
create index carts_business_status_idx on app.carts ("businessId", "status", "updatedAt" desc);

create table app.cart_lines (
  "id" uuid primary key default gen_random_uuid(), "businessId" uuid not null, "cartId" uuid not null, "productVariantId" uuid not null,
  "quantity" integer not null check ("quantity" > 0), "selectedModifiers" jsonb not null default '{}'::jsonb check (jsonb_typeof("selectedModifiers") = 'object'),
  "quotedUnitMinor" bigint check ("quotedUnitMinor" is null or "quotedUnitMinor" >= 0), "assetCode" text not null check ("assetCode" ~ '^[A-Z]{3}$'), "createdAt" timestamptz not null default now(), "updatedAt" timestamptz not null default now(),
  unique ("id", "businessId"), unique ("cartId", "productVariantId", "businessId"),
  foreign key ("cartId", "businessId") references app.carts ("id", "businessId") on delete cascade,
  foreign key ("productVariantId", "businessId") references app.product_variants ("id", "businessId") on delete restrict
);
create index cart_lines_cart_idx on app.cart_lines ("businessId", "cartId", "createdAt");

create table app.checkout_sessions (
  "id" uuid primary key default gen_random_uuid(), "businessId" uuid not null, "cartId" uuid not null, "status" text not null default 'open' check ("status" in ('open','expired','converted')),
  "expiresAt" timestamptz not null, "idempotencyKey" text not null, "createdAt" timestamptz not null default now(), "convertedAt" timestamptz,
  unique ("businessId", "idempotencyKey"), unique ("id", "businessId"), foreign key ("cartId", "businessId") references app.carts ("id", "businessId") on delete restrict
);
create index checkout_sessions_active_idx on app.checkout_sessions ("businessId", "cartId", "status", "expiresAt");

create table app.orders (
  "id" uuid primary key default gen_random_uuid(), "businessId" uuid not null references app.businesses ("id") on delete restrict, "orderNumber" text not null,
  "storeId" uuid not null, "channelId" uuid not null, "locationId" uuid, "customerPartyId" uuid, "cartId" uuid, "currency" text not null check ("currency" ~ '^[A-Z]{3}$'),
  "status" text not null default 'placed' check ("status" in ('placed','cancelled','fulfilled','refunded')),
  "paymentStatus" text not null default 'unpaid' check ("paymentStatus" in ('unpaid','partially_paid','paid','refunded')),
  "fulfillmentStatus" text not null default 'unfulfilled' check ("fulfillmentStatus" in ('unfulfilled','partial','fulfilled')),
  "subtotalMinor" bigint not null check ("subtotalMinor" >= 0), "discountMinor" bigint not null default 0 check ("discountMinor" >= 0), "taxMinor" bigint not null default 0 check ("taxMinor" >= 0), "totalMinor" bigint not null check ("totalMinor" >= 0),
  "createdBy" uuid references auth.user ("id") on delete restrict, "createdAt" timestamptz not null default now(), "updatedAt" timestamptz not null default now(), "cancelledAt" timestamptz,
  unique ("id", "businessId"), unique ("businessId", "orderNumber"), foreign key ("storeId", "businessId") references app.stores ("id", "businessId") on delete restrict,
  foreign key ("channelId", "storeId", "businessId") references app.sales_channels ("id", "storeId", "businessId") on delete restrict,
  foreign key ("locationId", "businessId") references app.locations ("id", "businessId") on delete restrict,
  foreign key ("customerPartyId", "businessId") references app.parties ("id", "businessId") on delete restrict,
  foreign key ("cartId", "businessId") references app.carts ("id", "businessId") on delete restrict
);
create index orders_business_created_idx on app.orders ("businessId", "createdAt" desc, "id" desc);
create index orders_business_status_idx on app.orders ("businessId", "status", "createdAt" desc);

create table app.order_lines (
  "id" uuid primary key default gen_random_uuid(), "businessId" uuid not null, "orderId" uuid not null, "productVariantId" uuid not null,
  "sku" text, "description" text not null, "quantity" integer not null check ("quantity" > 0), "unitPriceMinor" bigint not null check ("unitPriceMinor" >= 0), "discountMinor" bigint not null default 0 check ("discountMinor" >= 0), "taxMinor" bigint not null default 0 check ("taxMinor" >= 0), "lineTotalMinor" bigint not null check ("lineTotalMinor" >= 0), "assetCode" text not null check ("assetCode" ~ '^[A-Z]{3}$'), "selectedModifiers" jsonb not null default '{}'::jsonb check (jsonb_typeof("selectedModifiers") = 'object'), "createdAt" timestamptz not null default now(),
  unique ("id", "businessId"), foreign key ("orderId", "businessId") references app.orders ("id", "businessId") on delete restrict, foreign key ("productVariantId", "businessId") references app.product_variants ("id", "businessId") on delete restrict
);
create index order_lines_order_idx on app.order_lines ("businessId", "orderId", "createdAt");
alter table app.checkout_sessions add column "orderId" uuid;
alter table app.checkout_sessions add constraint checkout_sessions_order_fk foreign key ("orderId", "businessId") references app.orders ("id", "businessId") on delete restrict;

create trigger carts_set_updated_at before update on app.carts for each row execute function app.set_updated_at();
create trigger cart_lines_set_updated_at before update on app.cart_lines for each row execute function app.set_updated_at();
create trigger orders_set_updated_at before update on app.orders for each row execute function app.set_updated_at();

alter table app.carts enable row level security; alter table app.cart_lines enable row level security; alter table app.checkout_sessions enable row level security; alter table app.orders enable row level security; alter table app.order_lines enable row level security;
create policy carts_read on app.carts for select using (app.has_business_permission("businessId", 'cart.read'));
create policy carts_write on app.carts for all using (app.has_business_permission("businessId", 'cart.manage')) with check (app.has_business_permission("businessId", 'cart.manage'));
create policy cart_lines_read on app.cart_lines for select using (app.has_business_permission("businessId", 'cart.read'));
create policy cart_lines_write on app.cart_lines for all using (app.has_business_permission("businessId", 'cart.manage')) with check (app.has_business_permission("businessId", 'cart.manage'));
create policy checkout_read on app.checkout_sessions for select using (app.has_business_permission("businessId", 'cart.read'));
create policy checkout_write on app.checkout_sessions for all using (app.has_business_permission("businessId", 'cart.manage')) with check (app.has_business_permission("businessId", 'cart.manage'));
create policy orders_read on app.orders for select using (app.has_business_permission("businessId", 'order.read'));
create policy orders_create on app.orders for insert with check (app.has_business_permission("businessId", 'order.create'));
create policy orders_update on app.orders for update using (app.has_business_permission("businessId", 'order.create')) with check (app.has_business_permission("businessId", 'order.create'));
create policy order_lines_read on app.order_lines for select using (app.has_business_permission("businessId", 'order.read'));
create policy order_lines_create on app.order_lines for insert with check (app.has_business_permission("businessId", 'order.create'));
grant select, insert, update on app.carts, app.cart_lines, app.checkout_sessions, app.orders, app.order_lines to surge_app;
grant delete on app.cart_lines to surge_app;
