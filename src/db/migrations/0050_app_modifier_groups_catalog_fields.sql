-- app.modifier_groups/modifier_options were scaffolded (with RLS already
-- wired to product.read/modifier.manage/product.update) in
-- 0011_app_products_catalog but never finished: no domain code was ever
-- built on them, and the schema was missing fields the frontend's modifier
-- group management UI already expects (store scoping, description, the
-- modifier/add-on kind split, group ordering, branch availability, and
-- per-option availability/default/branch-availability). Both tables are
-- empty (never used), so these are safe to add as NOT NULL with defaults.

alter table app.modifier_groups
  add column "storeId" uuid not null references app.stores ("id") on delete cascade,
  add column "description" text not null default '',
  add column "kind" text not null default 'modifier' check ("kind" in ('modifier', 'addon')),
  add column "sortOrder" integer not null default 0 check ("sortOrder" >= 0),
  add column "branchIds" uuid[];

create index modifier_groups_store_order_idx on app.modifier_groups ("storeId", "status", "sortOrder");

alter table app.modifier_options
  add column "isAvailable" boolean not null default true,
  add column "isDefault" boolean not null default false,
  add column "branchIds" uuid[];
