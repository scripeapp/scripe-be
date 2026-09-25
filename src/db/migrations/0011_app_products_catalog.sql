-- Products/catalog vertical slice. Prices, inventory, orders, and uploads remain
-- separate domains and reference these stable product identities.

insert into app.permissions ("code", "description") values
  ('product.read', 'View products and catalog data'),
  ('product.create', 'Create products and variants'),
  ('product.update', 'Update products and variants'),
  ('product.archive', 'Archive products'),
  ('category.manage', 'Manage product categories'),
  ('modifier.manage', 'Manage product modifiers')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id"
from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
on conflict do nothing;

create table app.categories (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "parentId" uuid,
  "name" text not null check (length(trim("name")) between 1 and 120),
  "slug" text not null check ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  "description" text not null default '',
  "status" text not null default 'active' check ("status" in ('active', 'archived')),
  "sortOrder" integer not null default 0 check ("sortOrder" >= 0),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "archivedAt" timestamptz,
  unique ("id", "businessId"),
  unique ("businessId", "slug"),
  foreign key ("parentId", "businessId") references app.categories ("id", "businessId") on delete restrict,
  check ("parentId" is null or "parentId" <> "id")
);

create index categories_business_order_idx on app.categories ("businessId", "status", "sortOrder", "name");

create table app.products (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "storeId" uuid not null,
  "name" text not null check (length(trim("name")) between 1 and 200),
  "slug" text not null check ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  "description" text not null default '',
  "productType" text not null default 'physical' check ("productType" in ('physical', 'service', 'digital', 'menu', 'pharmacy')),
  "status" text not null default 'draft' check ("status" in ('draft', 'active', 'archived')),
  "isSellable" boolean not null default true,
  "trackInventory" boolean not null default false,
  "allowBackorder" boolean not null default false,
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "archivedAt" timestamptz,
  unique ("id", "businessId"),
  unique ("id", "storeId", "businessId"),
  unique ("businessId", "slug"),
  foreign key ("storeId", "businessId") references app.stores ("id", "businessId") on delete restrict
);

create index products_business_store_status_idx on app.products ("businessId", "storeId", "status", "createdAt" desc);

create table app.product_variants (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "productId" uuid not null,
  "sku" text,
  "name" text not null check (length(trim("name")) between 1 and 160),
  "optionValues" jsonb not null default '{}'::jsonb check (jsonb_typeof("optionValues") = 'object'),
  "unitId" uuid,
  "isDefault" boolean not null default false,
  "status" text not null default 'active' check ("status" in ('active', 'archived')),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "archivedAt" timestamptz,
  unique ("id", "businessId"),
  unique ("id", "productId", "businessId"),
  unique ("businessId", "sku"),
  foreign key ("productId", "businessId") references app.products ("id", "businessId") on delete restrict,
  check ("sku" is null or length(trim("sku")) between 1 and 120)
);

create unique index product_variants_one_default_idx on app.product_variants ("productId") where "isDefault" and "status" <> 'archived';
create index product_variants_product_idx on app.product_variants ("businessId", "productId", "status");

create table app.product_categories (
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "productId" uuid not null,
  "categoryId" uuid not null,
  "createdAt" timestamptz not null default now(),
  primary key ("productId", "categoryId"),
  foreign key ("productId", "businessId") references app.products ("id", "businessId") on delete cascade,
  foreign key ("categoryId", "businessId") references app.categories ("id", "businessId") on delete cascade
);

create table app.units (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "code" text not null check ("code" ~ '^[a-z][a-z0-9_]{0,39}$'),
  "name" text not null check (length(trim("name")) between 1 and 80),
  "symbol" text not null check (length(trim("symbol")) between 1 and 20),
  "isBase" boolean not null default true,
  "createdAt" timestamptz not null default now(),
  unique ("businessId", "code")
);

alter table app.product_variants
  add constraint product_variants_unit_fk foreign key ("unitId") references app.units ("id") on delete restrict;

create table app.unit_conversions (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "fromUnitId" uuid not null references app.units ("id") on delete restrict,
  "toUnitId" uuid not null references app.units ("id") on delete restrict,
  "factor" numeric(20, 8) not null check ("factor" > 0),
  "createdAt" timestamptz not null default now(),
  unique ("businessId", "fromUnitId", "toUnitId"),
  check ("fromUnitId" <> "toUnitId")
);

create table app.product_barcodes (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "variantId" uuid not null,
  "code" text not null check (length(trim("code")) between 3 and 120),
  "kind" text not null default 'barcode' check ("kind" in ('barcode', 'isbn', 'internal', 'alternate')),
  "createdAt" timestamptz not null default now(),
  unique ("businessId", "code"),
  foreign key ("variantId", "businessId") references app.product_variants ("id", "businessId") on delete cascade
);

create table app.modifier_groups (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "name" text not null check (length(trim("name")) between 1 and 120),
  "selectionMode" text not null default 'multiple' check ("selectionMode" in ('single', 'multiple')),
  "minSelections" integer not null default 0 check ("minSelections" >= 0),
  "maxSelections" integer check ("maxSelections" is null or "maxSelections" >= "minSelections"),
  "status" text not null default 'active' check ("status" in ('active', 'archived')),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("id", "businessId")
);

create table app.modifier_options (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "groupId" uuid not null,
  "name" text not null check (length(trim("name")) between 1 and 120),
  "priceAdjustmentMinor" bigint not null default 0,
  "sortOrder" integer not null default 0 check ("sortOrder" >= 0),
  "status" text not null default 'active' check ("status" in ('active', 'archived')),
  "createdAt" timestamptz not null default now(),
  foreign key ("groupId", "businessId") references app.modifier_groups ("id", "businessId") on delete cascade,
  unique ("id", "businessId")
);

create table app.product_modifier_groups (
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "productId" uuid not null,
  "groupId" uuid not null,
  "sortOrder" integer not null default 0 check ("sortOrder" >= 0),
  "createdAt" timestamptz not null default now(),
  primary key ("productId", "groupId"),
  foreign key ("productId", "businessId") references app.products ("id", "businessId") on delete cascade,
  foreign key ("groupId", "businessId") references app.modifier_groups ("id", "businessId") on delete cascade
);

create trigger categories_set_updated_at before update on app.categories for each row execute function app.set_updated_at();
create trigger products_set_updated_at before update on app.products for each row execute function app.set_updated_at();
create trigger product_variants_set_updated_at before update on app.product_variants for each row execute function app.set_updated_at();
create trigger modifier_groups_set_updated_at before update on app.modifier_groups for each row execute function app.set_updated_at();

alter table app.categories enable row level security;
alter table app.products enable row level security;
alter table app.product_variants enable row level security;
alter table app.product_categories enable row level security;
alter table app.units enable row level security;
alter table app.unit_conversions enable row level security;
alter table app.product_barcodes enable row level security;
alter table app.modifier_groups enable row level security;
alter table app.modifier_options enable row level security;
alter table app.product_modifier_groups enable row level security;

create policy categories_read on app.categories for select using (app.has_business_permission("businessId", 'product.read'));
create policy categories_write on app.categories for all using (app.has_business_permission("businessId", 'category.manage')) with check (app.has_business_permission("businessId", 'category.manage'));
create policy products_read on app.products for select using (app.has_business_permission("businessId", 'product.read'));
create policy products_create on app.products for insert with check (app.has_business_permission("businessId", 'product.create'));
create policy products_update on app.products for update using (app.has_business_permission("businessId", 'product.update')) with check (app.has_business_permission("businessId", 'product.update'));
create policy variants_read on app.product_variants for select using (app.has_business_permission("businessId", 'product.read'));
create policy variants_write on app.product_variants for all using (app.has_business_permission("businessId", 'product.update')) with check (app.has_business_permission("businessId", 'product.update'));
create policy product_categories_read on app.product_categories for select using (app.has_business_permission("businessId", 'product.read'));
create policy product_categories_write on app.product_categories for all using (app.has_business_permission("businessId", 'product.update')) with check (app.has_business_permission("businessId", 'product.update'));
create policy units_read on app.units for select using (app.has_business_permission("businessId", 'product.read'));
create policy units_write on app.units for all using (app.has_business_permission("businessId", 'product.update')) with check (app.has_business_permission("businessId", 'product.update'));
create policy unit_conversions_read on app.unit_conversions for select using (app.has_business_permission("businessId", 'product.read'));
create policy unit_conversions_write on app.unit_conversions for all using (app.has_business_permission("businessId", 'product.update')) with check (app.has_business_permission("businessId", 'product.update'));
create policy barcodes_read on app.product_barcodes for select using (app.has_business_permission("businessId", 'product.read'));
create policy barcodes_write on app.product_barcodes for all using (app.has_business_permission("businessId", 'product.update')) with check (app.has_business_permission("businessId", 'product.update'));
create policy modifier_groups_read on app.modifier_groups for select using (app.has_business_permission("businessId", 'product.read'));
create policy modifier_groups_write on app.modifier_groups for all using (app.has_business_permission("businessId", 'modifier.manage')) with check (app.has_business_permission("businessId", 'modifier.manage'));
create policy modifier_options_read on app.modifier_options for select using (app.has_business_permission("businessId", 'product.read'));
create policy modifier_options_write on app.modifier_options for all using (app.has_business_permission("businessId", 'modifier.manage')) with check (app.has_business_permission("businessId", 'modifier.manage'));
create policy product_modifier_groups_read on app.product_modifier_groups for select using (app.has_business_permission("businessId", 'product.read'));
create policy product_modifier_groups_write on app.product_modifier_groups for all using (app.has_business_permission("businessId", 'product.update')) with check (app.has_business_permission("businessId", 'product.update'));

grant select, insert, update on app.categories, app.products, app.product_variants, app.product_categories,
  app.units, app.unit_conversions, app.product_barcodes, app.modifier_groups, app.modifier_options,
  app.product_modifier_groups to scripe_app;
