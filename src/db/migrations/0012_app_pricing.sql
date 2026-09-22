insert into app.permissions ("code", "description") values
  ('pricing.read', 'View product prices and tax configuration'),
  ('pricing.manage', 'Manage product prices, availability, and tax configuration')
on conflict ("code") do nothing;
insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
on conflict do nothing;

create table app.product_prices (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "productVariantId" uuid not null,
  "locationId" uuid,
  "assetCode" text not null check ("assetCode" ~ '^[A-Z]{3}$'),
  "amountMinor" bigint not null check ("amountMinor" >= 0),
  "compareAtMinor" bigint check ("compareAtMinor" is null or "compareAtMinor" >= "amountMinor"),
  "status" text not null default 'active' check ("status" in ('active', 'archived')),
  "effectiveFrom" timestamptz not null default now(),
  "effectiveTo" timestamptz,
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "archivedAt" timestamptz,
  unique ("id", "businessId"),
  foreign key ("productVariantId", "businessId") references app.product_variants ("id", "businessId") on delete restrict,
  foreign key ("locationId", "businessId") references app.locations ("id", "businessId") on delete restrict,
  check ("effectiveTo" is null or "effectiveTo" > "effectiveFrom")
);
create unique index product_prices_unique_grain on app.product_prices ("productVariantId", "locationId", "assetCode") where "status" = 'active';
create index product_prices_lookup_idx on app.product_prices ("businessId", "productVariantId", "assetCode", "locationId", "status");

create table app.product_location_settings (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "productId" uuid not null,
  "locationId" uuid not null,
  "isAvailable" boolean not null default true,
  "leadTimeMinutes" integer check ("leadTimeMinutes" is null or "leadTimeMinutes" >= 0),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("businessId", "productId", "locationId"),
  foreign key ("productId", "businessId") references app.products ("id", "businessId") on delete cascade,
  foreign key ("locationId", "businessId") references app.locations ("id", "businessId") on delete restrict
);

create table app.tax_rates (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "code" text not null check ("code" ~ '^[a-z][a-z0-9_]{1,39}$'),
  "name" text not null check (length(trim("name")) between 1 and 120),
  "rateBps" integer not null check ("rateBps" between 0 and 10000),
  "isInclusive" boolean not null default false,
  "status" text not null default 'active' check ("status" in ('active', 'archived')),
  "effectiveFrom" timestamptz not null default now(),
  "effectiveTo" timestamptz,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("businessId", "code"),
  check ("effectiveTo" is null or "effectiveTo" > "effectiveFrom")
);

create trigger product_prices_set_updated_at before update on app.product_prices for each row execute function app.set_updated_at();
create trigger product_location_settings_set_updated_at before update on app.product_location_settings for each row execute function app.set_updated_at();
create trigger tax_rates_set_updated_at before update on app.tax_rates for each row execute function app.set_updated_at();

alter table app.product_prices enable row level security;
alter table app.product_location_settings enable row level security;
alter table app.tax_rates enable row level security;
create policy product_prices_read on app.product_prices for select using (app.has_business_permission("businessId", 'pricing.read'));
create policy product_prices_write on app.product_prices for all using (app.has_business_permission("businessId", 'pricing.manage')) with check (app.has_business_permission("businessId", 'pricing.manage'));
create policy product_location_settings_read on app.product_location_settings for select using (app.has_business_permission("businessId", 'pricing.read'));
create policy product_location_settings_write on app.product_location_settings for all using (app.has_business_permission("businessId", 'pricing.manage')) with check (app.has_business_permission("businessId", 'pricing.manage'));
create policy tax_rates_read on app.tax_rates for select using (app.has_business_permission("businessId", 'pricing.read'));
create policy tax_rates_write on app.tax_rates for all using (app.has_business_permission("businessId", 'pricing.manage')) with check (app.has_business_permission("businessId", 'pricing.manage'));
grant select, insert, update on app.product_prices, app.product_location_settings, app.tax_rates to surge_app;
